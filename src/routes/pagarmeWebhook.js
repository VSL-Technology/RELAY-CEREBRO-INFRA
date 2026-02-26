import express from "express";
import crypto from "crypto";
import logger from "../services/logger.js";

const router = express.Router();

function getHeaderValue(headerValue) {
  if (Array.isArray(headerValue)) return headerValue[0] || "";
  return typeof headerValue === "string" ? headerValue : "";
}

function normalizeSignature(signature) {
  const value = signature.trim();
  return value.startsWith("sha256=") ? value.slice(7) : value;
}

function isValidHex(hex) {
  return /^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0;
}

router.post(
  "/api/webhooks/pagarme",
  express.raw({ type: "application/json", limit: "2mb" }),
  async (req, res) => {
    try {
      const signatureHeader = getHeaderValue(
        req.headers["x-hub-signature"] || req.headers["x-pagarme-signature"]
      );

      if (!signatureHeader) {
        return res.status(400).json({ error: "Missing signature" });
      }

      if (!Buffer.isBuffer(req.body)) {
        return res.status(400).json({ error: "Invalid raw body" });
      }

      const secret = process.env.PAGARME_WEBHOOK_SECRET;
      if (!secret) {
        return res.status(500).json({ error: "Webhook secret not configured" });
      }

      const receivedHex = normalizeSignature(signatureHeader);
      if (!isValidHex(receivedHex)) {
        return res.status(401).json({ error: "Invalid signature" });
      }

      const expectedDigest = crypto
        .createHmac("sha256", secret)
        .update(req.body)
        .digest();
      const receivedDigest = Buffer.from(receivedHex, "hex");

      if (
        expectedDigest.length !== receivedDigest.length ||
        !crypto.timingSafeEqual(expectedDigest, receivedDigest)
      ) {
        return res.status(401).json({ error: "Invalid signature" });
      }

      const parsed = JSON.parse(req.body.toString("utf8"));
      logger.info("pagarme.webhook.received", {
        route: "pagarme_webhook",
        receivedAt: new Date().toISOString(),
        event: parsed?.type || null
      });

      return res.sendStatus(200);
    } catch (err) {
      logger.error("pagarme.webhook.error", { message: err?.message || String(err) });
      return res.status(500).json({ error: "Webhook processing failed" });
    }
  }
);

export default router;
