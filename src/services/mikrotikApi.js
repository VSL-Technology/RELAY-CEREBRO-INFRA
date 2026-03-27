// src/services/mikrotikApi.js
// Direct RouterOS API implementation via TCP socket
import net from "net";

function encodeLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x4000) return Buffer.from([((len >> 8) & 0x3f) | 0x80, len & 0xff]);
  if (len < 0x200000) return Buffer.from([((len >> 16) & 0x1f) | 0xc0, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.from([((len >> 24) & 0x0f) | 0xe0, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
}

function encodeWord(word) {
  const wordBuf = Buffer.from(word, "utf8");
  return Buffer.concat([encodeLength(wordBuf.length), wordBuf]);
}

function encodeSentence(words) {
  const parts = words.map(encodeWord);
  parts.push(Buffer.from([0])); // end of sentence
  return Buffer.concat(parts);
}

function decodeLength(buf, offset) {
  const b = buf[offset];
  if ((b & 0x80) === 0) return { len: b, bytesRead: 1 };
  if ((b & 0xc0) === 0x80) return { len: ((b & 0x3f) << 8) | buf[offset + 1], bytesRead: 2 };
  if ((b & 0xe0) === 0xc0) return { len: ((b & 0x1f) << 16) | (buf[offset + 1] << 8) | buf[offset + 2], bytesRead: 3 };
  return { len: ((b & 0x0f) << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3], bytesRead: 4 };
}

function parseReply(buf) {
  const sentences = [];
  let current = [];
  let offset = 0;

  while (offset < buf.length) {
    const { len, bytesRead } = decodeLength(buf, offset);
    offset += bytesRead;
    if (len === 0) {
      if (current.length > 0) sentences.push(current);
      current = [];
    } else {
      const word = buf.slice(offset, offset + len).toString("utf8");
      offset += len;
      current.push(word);
    }
  }
  return sentences;
}

export async function runCommands(host, port, user, pass, commands, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = Buffer.alloc(0);
    let authenticated = false;
    let results = [];
    let cmdIndex = 0;
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err) reject(err);
      else resolve({ ok: true, results });
    };

    const timer = setTimeout(() => finish(new Error("RouterOS API timeout")), timeoutMs);

    const send = (words) => {
      socket.write(encodeSentence(words));
    };

    const processLine = (sentences) => {
      for (const sentence of sentences) {
        if (!sentence.length) continue;
        const type = sentence[0];

        if (!authenticated) {
          if (type === "!done") {
            authenticated = true;
            sendNextCommand();
          } else if (type === "!trap" || type === "!fatal") {
            clearTimeout(timer);
            finish(new Error("Auth failed: " + sentence.join(" ")));
          }
          continue;
        }

        if (type === "!re") {
          const row = {};
          sentence.slice(1).forEach(w => {
            const eq = w.indexOf("=", 1);
            if (eq > 0) row[w.slice(1, eq)] = w.slice(eq + 1);
          });
          if (results[cmdIndex]) results[cmdIndex].data.push(row);
        } else if (type === "!done") {
          if (results[cmdIndex]) results[cmdIndex].ok = true;
          cmdIndex++;
          if (cmdIndex >= commands.length) {
            clearTimeout(timer);
            finish(null);
          } else {
            sendNextCommand();
          }
        } else if (type === "!trap") {
          if (results[cmdIndex]) {
            results[cmdIndex].ok = false;
            results[cmdIndex].error = sentence.slice(1).join(" ");
          }
          cmdIndex++;
          if (cmdIndex >= commands.length) {
            clearTimeout(timer);
            finish(null);
          } else {
            sendNextCommand();
          }
        }
      }
    };

    const sendNextCommand = () => {
      const cmd = commands[cmdIndex];
      results[cmdIndex] = { cmd: Array.isArray(cmd) ? cmd.join(" ") : cmd, ok: false, data: [] };
      send(Array.isArray(cmd) ? cmd : [cmd]);
    };

    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      const sentences = parseReply(buffer);
      buffer = Buffer.alloc(0);
      processLine(sentences);
    });

    socket.on("error", (err) => { clearTimeout(timer); finish(err); });
    socket.on("close", () => { clearTimeout(timer); if (!done) finish(new Error("Connection closed")); });

    socket.connect(port, host, () => {
      // Login sequence
      send(["/login", "=name=" + user, "=password=" + pass]);
    });
  });
}
