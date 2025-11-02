// server.js
import express from "express";
import fetch from "node-fetch";
import FormData from "form-data";
import admin from "firebase-admin";
import dotenv from "dotenv";
dotenv.config();

// ✅ Initialize express before routes
const app = express();
app.use(express.json({ limit: "20mb" })); // allow larger JSON base64 payloads

// Optional: add CORS (safe if ever tested on web)
import cors from "cors";
app.use(cors());

// ✅ Warm-up route
app.get("/", (req, res) => {
  console.log("🔹 GET / - Backend is alive");
  res.send("EPWD Backend Active ✅");
});

// ✅ Initialize Firebase
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
  });
}
const db = admin.firestore();

// --- ENV KEYS ---
const OCR_API_KEY = process.env.OCR_API_KEY;
const FACE_API_KEY = process.env.FACE_API_KEY;
const FACE_API_SECRET = process.env.FACE_API_SECRET;

// --- HELPER ---
function extractSilayIdDetails(rawText = "") {
  const textLower = rawText.toLowerCase();
  const isSilay = textLower.includes("silay");
  let id = "";
  const idPattern = /\b\d{13}\b/;
  const match = rawText.match(idPattern);
  if (match) id = match[0];
  return {
    isSilay,
    id,
    message: isSilay
      ? id
        ? `Found Silay ID ${id}`
        : "Silay document detected but no ID number found."
      : "Not a Silay City PWD ID.",
  };
}

// --- OCR + Firestore Lookup ---
app.post("/api/scan", async (req, res) => {
  console.log("📩 Received /api/scan request");
  try {
    const { base64Image } = req.body;
    console.log("🧾 Body size:", base64Image ? base64Image.length : "No image");

    if (!base64Image)
      return res.status(400).json({ error: "Missing image data" });

    // OCR API call
    const form = new FormData();
    form.append("apikey", OCR_API_KEY);
    form.append("OCREngine", "2");
    form.append("base64Image", `data:image/jpeg;base64,${base64Image}`);

    console.log("🔍 Sending image to OCR.Space...");
    const ocrRes = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      body: form,
    });
    const ocrData = await ocrRes.json();

    if (!ocrData.ParsedResults || ocrData.ParsedResults.length === 0)
      throw new Error("OCR failed to extract text.");

    const parsedText = ocrData.ParsedResults[0].ParsedText;
    const idDetails = extractSilayIdDetails(parsedText);

    if (!idDetails.isSilay)
      return res.status(400).json({ message: idDetails.message });

    console.log("🔎 Querying Firestore for:", idDetails.id);
    const snapshot = await db
      .collection("EPWD")
      .where("PWD_ID_NO", "==", idDetails.id)
      .get();

    if (snapshot.empty)
      return res.status(404).json({ message: "PWD record not found." });

    const member = snapshot.docs[0].data();

    console.log("✅ Match found:", member.FirstName, member.LastName);

    res.json({
      idDetails,
      member,
      message: "Record found and verified.",
    });
  } catch (err) {
    console.error("❌ Scan API error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Face Verification ---
app.post("/api/face-verify", async (req, res) => {
  console.log("📩 Received /api/face-verify request");
  try {
    const { selfieBase64, profileBase64 } = req.body;
    if (!selfieBase64 || !profileBase64)
      return res.status(400).json({ error: "Missing images" });

    const form = new FormData();
    form.append("api_key", FACE_API_KEY);
    form.append("api_secret", FACE_API_SECRET);
    form.append("image_base64_1", selfieBase64);
    form.append("image_base64_2", profileBase64);

    const apiRes = await fetch(
      "https://api-us.faceplusplus.com/facepp/v3/compare",
      { method: "POST", body: form }
    );
    const data = await apiRes.json();

    if (data.error_message)
      return res.status(400).json({ error: data.error_message });

    res.json({
      confidence: data.confidence,
      thresholds: data.thresholds,
    });
  } catch (err) {
    console.error("❌ Face Verify API error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Start Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
