// src/services/eventConsumer.js
// Polling consumer with pluggable fetcher. Default fetcher reads a local file `events_queue.json`.
import fs from "fs/promises";
import path from "path";
import jobStore from "./jobStore.js";
import { processEvent } from "./stateMachine.js";
import crypto from "crypto";
import logger from "./logger.js";
import metrics from "./metrics.js";
import peerBinding from "./peerBinding.service.js";

const DEFAULT_POLL_MS = 3000;
const REQUIRE_BACKEND_HMAC = process.env.BACKEND_REQUIRE_HMAC === '1' || process.env.BACKEND_REQUIRE_HMAC === 'true';
const BACKEND_ACK_URL = process.env.BACKEND_ACK_URL || null;
const ACK_RETRIES = Number(process.env.BACKEND_ACK_RETRIES || 2);
const ACK_RETRY_DELAY_MS = Number(process.env.BACKEND_ACK_RETRY_DELAY_MS || 500);

async function defaultFetcher() {
  const p = path.resolve(process.cwd(), "events_queue.json");
  try {
    const raw = await fs.readFile(p, "utf8");
    const arr = JSON.parse(raw || "[]");
    // clear file after read
    await fs.writeFile(p, "[]", "utf8");
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

async function httpFetcher() {
  const url = process.env.BACKEND_EVENTS_URL;
  const secret = process.env.BACKEND_HMAC_SECRET;
  if (!url) return [];
  try {
    const ts = Date.now().toString();
    const sig = secret ? crypto.createHmac('sha256', secret).update(ts).digest('hex') : '';
    const fetchMod = await import('node-fetch');
    const fetch = fetchMod.default || fetchMod;
    const res = await fetch(url, { headers: { 'x-relay-ts': ts, 'x-relay-hmac': sig }, timeout: 5000 });
    if (!res.ok) {
      console.error('[consumer] backend returned', res.status);
      metrics.inc('consumer.http_fetch_error');
      return [];
    }
    const body = await res.text();
    // verification: if BACKEND_HMAC_SECRET is configured, require x-backend-hmac
    try {
      const backendSig = res.headers.get('x-backend-hmac');
      if (secret || REQUIRE_BACKEND_HMAC) {
        if (!backendSig) {
          console.error('[consumer] missing x-backend-hmac header from backend while BACKEND_HMAC_SECRET is set/required');
          metrics.inc('consumer.missing_hmac');
          return [];
        }
        try {
          const expected = crypto.createHmac('sha256', secret || '').update(body).digest('hex');
          const a = Buffer.from(expected, 'hex');
          const b = Buffer.from(backendSig, 'hex');
          // timing-safe comparison
          if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            console.error('[consumer] backend hmac mismatch');
            metrics.inc('consumer.hmac_mismatch');
            return [];
          }
        } catch (e) {
          console.error('[consumer] backend hmac verification error', e && e.message);
          metrics.inc('consumer.hmac_error');
          return [];
        }
      }
      const events = JSON.parse(body || '[]');
      metrics.inc('consumer.http_fetch_ok');
      return Array.isArray(events) ? events : [];
    } catch (e) {
      console.error('[consumer] invalid json from backend', e && e.message);
      metrics.inc('consumer.http_parse_error');
      return [];
    }
  } catch (e) {
    console.error('[consumer] httpFetcher error', e.message);
    metrics.inc('consumer.http_error');
    return [];
  }
}

function validateEventShape(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (!ev.eventId || typeof ev.eventId !== 'string') return false;
  if (!ev.type || typeof ev.type !== 'string') return false;
  return true;
}

async function sendAck(eventId, ok, payload = {}) {
  if (!BACKEND_ACK_URL) return;
  const ts = Date.now().toString();
  const body = JSON.stringify({ eventId, ok, payload });
  const headers = { 'Content-Type': 'application/json', 'x-relay-ts': ts };
  const secret = process.env.BACKEND_HMAC_SECRET;
  if (secret) {
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    headers['x-relay-hmac'] = sig;
  }
  const fetchMod = await import('node-fetch');
  const fetch = fetchMod.default || fetchMod;
  for (let attempt = 0; attempt <= ACK_RETRIES; attempt++) {
    try {
      await fetch(BACKEND_ACK_URL, { method: 'POST', headers, body, timeout: 5000 });
      metrics.inc('consumer.ack_sent');
      return;
    } catch (e) {
      metrics.inc('consumer.ack_error');
      logger.error('consumer.ack_error', { attempt, message: e && e.message });
      if (attempt < ACK_RETRIES) {
        await new Promise((r) => setTimeout(r, ACK_RETRY_DELAY_MS));
        continue;
      }
      break;
    }
  }
}

export class EventConsumer {
  constructor({ fetcher = defaultFetcher, pollMs = DEFAULT_POLL_MS } = {}) {
    this.fetcher = fetcher;
    this.pollMs = pollMs;
    this._running = false;
    this._timer = null;
  }

  async _tick() {
    try {
      // select fetcher: if BACKEND_EVENTS_URL provided use httpFetcher by default
      let events;
      if (this.fetcher && this.fetcher !== defaultFetcher) {
        events = await this.fetcher();
      } else if (process.env.BACKEND_EVENTS_URL) {
        events = await httpFetcher();
      } else {
        events = await this.fetcher();
      }
      if (!events || events.length === 0) return;
      for (const ev of events) {
        try {
          if (!validateEventShape(ev)) {
            metrics.inc('consumer.invalid_event');
            logger.warn('consumer.invalid_event', { ev });
            continue;
          }
          if (!ev || !ev.eventId) continue;
          const already = await Promise.resolve(jobStore.isEventProcessed(ev.eventId));
          if (already) {
            logger.info('consumer.skipping_processed_event', { eventId: ev.eventId });
            continue;
          }
          // hand to state machine (it will mark processed when appropriate)
          try {
            const res = await processEvent(ev);
            await sendAck(ev.eventId, !!(res && res.ok), res);
          } catch (err) {
            logger.error('consumer.processEvent_error', { message: err && err.message });
            metrics.inc('consumer.process_error');
          }
        } catch (e) {
          logger.error('consumer.event_handling_error', { message: e && e.message });
        }
      }
    } catch (e) {
      logger.error('consumer.fetch_error', { message: e && e.message });
    }
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._timer = setInterval(() => this._tick(), this.pollMs);
    logger.info('consumer.started');
  }

  stop() {
    if (!this._running) return;
    clearInterval(this._timer);
    this._running = false;
    this._timer = null;
    logger.info('consumer.stopped');
  }
}

export default EventConsumer;
