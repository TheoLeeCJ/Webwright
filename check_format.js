const fs = require('fs');

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function detectFormat(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return null;
  }
  const object = safeJsonParse(trimmed);
  if (object && typeof object === 'object' && Array.isArray(object.messages) && object.info) {
    return 'trajectory';
  }
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  let parsed = 0;
  let eventLike = 0;
  for (const line of lines.slice(0, 40)) {
    const item = safeJsonParse(line);
    if (item && typeof item === 'object') {
      parsed += 1;
      if (item.timestamp && item.type) {
        eventLike += 1;
      }
    }
  }
  if (parsed >= Math.min(lines.length, 4) && eventLike >= Math.min(parsed, 3)) {
    return 'codex_jsonl';
  }
  return null;
}

const files = [
  'outputs/default/demo_openai_20260519_231305/trajectory.json',
  'sample-codex.jsonl',
  'outputs/default/demo_openai_20260519_231305/raw_responses.jsonl'
];

files.forEach(file => {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const format = detectFormat(content);
    console.log(`${file}: ${format}`);
    if (file.endsWith('trajectory.json') && format === null) {
        const object = safeJsonParse(content.trim());
        console.log('--- Trajectory Debug ---');
        console.log('isObject:', !!object && typeof object === 'object');
        console.log('isArrayMessages:', object ? Array.isArray(object.messages) : 'N/A');
        console.log('hasInfo:', object ? !!object.info : 'N/A');
    }
  } catch (err) {
    console.log(`${file}: Error reading file: ${err.message}`);
  }
});
