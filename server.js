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

  // --- Name extraction ---
  let firstName = "", middleName = "", lastName = "";
  const lines = rawText.split("\n").map(l => l.trim());
  for (const line of lines) {
    if (/^(?:FIRST\s*NAME|GIVEN\s*NAME|UNANG\s*PANGALAN)\s*[:\-]?\s*(.+)$/i.test(line)) {
      firstName = RegExp.$1.trim();
    }
    if (/^(?:MIDDLE\s*NAME|GITNANG\s*PANGALAN|M\.?\s*I\.?)\s*[:\-]?\s*(.+)$/i.test(line)) {
      middleName = RegExp.$1.trim();
    }
    if (/^(?:LAST\s*NAME|SURNAME|APELYIDO)\s*[:\-]?\s*(.+)$/i.test(line)) {
      lastName = RegExp.$1.trim();
    }
    if (/^(?:NAME|PANGALAN)\s*[:\-]?\s*(.+)$/i.test(line) && !firstName && !lastName) {
      const parts = RegExp.$1.trim().split(/\s+/);
      if (parts.length >= 2) {
        firstName = parts[0];
        lastName = parts[parts.length - 1];
        if (parts.length === 3) middleName = parts[1];
      }
    }
  }

  return {
    isSilay,
    id,
    firstName,
    middleName,
    lastName,
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

    if (snapshot.empty) {
      console.log("⚠️ No matching Firestore record found, returning OCR data only.");

      return res.status(404).json({
        message: "PWD record not found.",
        idDetails, // include extracted ID and name info
      });
    }


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

// ⭐️ NEW ROUTE: Proxy for Expo Push Notifications ⭐️
app.post('/api/notify', async (req, res) => {
    console.log("📩 Received /api/notify request");
    try {
        const { to, title, body, data } = req.body;

        // Basic Validation
        if (!to) {
            return res.status(400).json({ error: "Missing 'to' token" });
        }

        console.log(`📨 Sending notification to: ${to}`);

        // Forward the request to Expo's servers
        const response = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Accept-encoding': 'gzip, deflate',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                to: to,
                sound: 'default',
                title: title || "New Notification",
                body: body || "You have a new update.",
                data: data || {}
            }),
        });

        const result = await response.json();
        console.log("✅ Expo Response:", result);
        
        res.json(result);

    } catch (error) {
        console.error("❌ Notification Proxy Error:", error);
        res.status(500).json({ error: "Failed to send notification" });
    }
});

// --- Start Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});