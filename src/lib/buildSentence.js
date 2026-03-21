export function buildSentence(command, params = {}) {
  const sentence = [String(command || "").trim()];

  for (const [key, value] of Object.entries(params)) {
    if (!key || value === undefined || value === null) continue;
    sentence.push(`=${key}=${value}`);
  }

  return sentence.filter(Boolean);
}

export default buildSentence;
