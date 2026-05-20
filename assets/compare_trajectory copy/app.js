function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function shortText(value, limit = 220) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (!clean) {
    return '';
  }
  return clean.length > limit ? clean.slice(0, limit - 3) + '...' : clean;
}

function shortMultiline(value, limit = 440) {
  const clean = String(value || '').trim();
  if (!clean) {
    return '';
  }
  return clean.length > limit ? clean.slice(0, limit - 3) + '...' : clean;
}

function numberFormat(value) {
  if (value === null || value === undefined || value === '') {
    return 'n/a';
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return String(value);
  }
  return new Intl.NumberFormat().format(number);
}

function formatTimestamp(value) {
  if (!value) {
    return 'n/a';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString();
}

function detectFormat(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) {
    return null;
  }
  const first = safeJsonParse(lines[0]);
  if (!first || typeof first !== 'object') {
    return null;
  }
  if (first.timestamp && first.type) {
    return 'codex_jsonl';
  }
  if (first.event === 'raw_text' && typeof first.raw_text === 'string') {
    return 'raw_response_jsonl';
  }
  return null;
}

function parseArguments(raw) {
  if (!raw) {
    return {};
  }
  if (typeof raw === 'object') {
    return raw;
  }
  const parsed = safeJsonParse(raw);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function primaryCommand(raw) {
  const input = String(raw || '').trim();
  if (!input) {
    return 'none';
  }
  const pieces = input.split(/&&|\|\|/).map((piece) => piece.trim()).filter(Boolean);
  const target = pieces.find((piece) => !/^cd\s+/.test(piece)) || pieces[0] || input;
  if (target.startsWith('python - <<')) {
    return 'python-heredoc';
  }
  if (target.startsWith('printf ')) {
    return 'printf';
  }
  const match = target.match(/^([A-Za-z0-9._/-]+)/);
  return match ? match[1] : shortText(target, 40);
}

function parseExitCode(text) {
  const match = String(text || '').match(/(?:Return code:|Process exited with code)\s*(-?\d+)/i);
  return match ? Number(match[1]) : null;
}

function parseSessionId(text) {
  const match = String(text || '').match(/session(?:\s+ID)?\s+(\d+)/i);
  return match ? match[1] : '';
}

function countBy(items, selector) {
  const counts = new Map();
  for (const item of items) {
    const key = selector(item);
    if (!key) {
      continue;
    }
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, value]) => ({ label, value }));
}

function toBarRows(rows, limit = 6) {
  const subset = rows.slice(0, limit);
  const max = subset.reduce((value, row) => Math.max(value, row.value), 0) || 1;
  return subset.map((row) => ({
    label: row.label,
    value: row.value,
    width: Math.max(8, Math.round((row.value / max) * 100))
  }));
}

function tokenRowsFromTotals(tokens) {
  if (!tokens) {
    return [{ label: 'availability', value: 'n/a' }];
  }
  return [
    { label: 'input', value: numberFormat(tokens.input_tokens) },
    { label: 'output', value: numberFormat(tokens.output_tokens) },
    { label: 'reasoning', value: numberFormat(tokens.reasoning_output_tokens) },
    { label: 'cached', value: numberFormat(tokens.cached_input_tokens) },
    { label: 'total', value: numberFormat(tokens.total_tokens) }
  ];
}

function statusFromExit(exitCode, sessionId, output, done) {
  if (exitCode === 0) {
    return { label: 'ok', css: 'good' };
  }
  if (exitCode !== null && exitCode !== 0) {
    return { label: 'error', css: 'bad' };
  }
  if (done === true) {
    return { label: 'done', css: 'good' };
  }
  if (sessionId || /process running/i.test(String(output || ''))) {
    return { label: 'streaming', css: 'warn' };
  }
  return { label: 'unknown', css: '' };
}

function splitConcatenatedJsonObjects(text) {
  const source = String(text || '');
  const segments = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (start === -1) {
      if (char === '{') {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        segments.push(source.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return segments.map((segment) => safeJsonParse(segment)).filter(Boolean);
}

function finalizeTrace(base) {
  const commandFamilies = toBarRows(countBy(base.commandRuns, (run) => run.primaryCommand));
  const defaultChannelFamilies = toBarRows(countBy(base.events, (event) => event.kind));
  return {
    side: base.side,
    kind: base.kind,
    formatLabel: base.formatLabel,
    description: base.description,
    fileName: base.fileName,
    filePath: base.filePath,
    taskPrompt: base.taskPrompt,
    events: base.events,
    thoughtEntries: base.thoughtEntries,
    commandRuns: base.commandRuns,
    finalResponses: base.finalResponses,
    tokenRows: base.tokenRows,
    metrics: base.metrics,
    commandFamilies,
    channelFamilies: base.channelFamilies || defaultChannelFamilies,
    summary: {
      thoughts: base.thoughtEntries.length,
      commands: base.commandRuns.length,
      commandRuns: base.commandRuns.length,
      finalResponses: base.finalResponses.length,
      events: base.events.length
    }
  };
}

function normalizeCodex(text, fileName, filePath, side) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const entries = [];
  const callById = new Map();
  const runByCallId = new Map();
  const runBySession = new Map();
  const commandRuns = [];
  const thoughtEntries = [];
  const finalResponses = [];
  const events = [];
  let latestTokens = null;
  let thoughtOrder = 0;
  let commandOrder = 0;
  let userPrompt = '';

  lines.forEach((line) => {
    const item = safeJsonParse(line);
    if (!item || typeof item !== 'object') {
      return;
    }
    entries.push(item);
    if (item.type === 'event_msg' && item.payload && item.payload.type === 'token_count') {
      latestTokens = item.payload.info ? item.payload.info.total_token_usage : null;
    }
  });

  entries.forEach((item, index) => {
    const id = side + '-codex-' + index;
    const timeLabel = formatTimestamp(item.timestamp || '');

    if (item.type === 'event_msg' && item.payload && item.payload.type === 'user_message') {
      const summary = shortMultiline(item.payload.message, 360);
      if (!userPrompt) {
        userPrompt = summary;
      }
      events.push({
        id,
        kind: 'user_message',
        summary,
        timeLabel,
        chips: ['user']
      });
      return;
    }

    if (item.type === 'event_msg' && item.payload && item.payload.type === 'agent_message') {
      thoughtOrder += 1;
      const textBody = shortMultiline(item.payload.message, 520);
      thoughtEntries.push({
        id,
        order: thoughtOrder,
        text: textBody,
        timeLabel,
        chips: [item.payload.phase || 'commentary']
      });
      events.push({
        id,
        kind: 'thought',
        summary: textBody,
        timeLabel,
        chips: [item.payload.phase || 'commentary']
      });
      if (/final|answer|result/i.test(item.payload.phase || '') && textBody) {
        finalResponses.push({ id: id + '-final', text: textBody, timeLabel });
      }
      return;
    }

    if (item.type === 'event_msg' && item.payload && item.payload.type === 'token_count') {
      const total = item.payload.info && item.payload.info.total_token_usage ? item.payload.info.total_token_usage : {};
      events.push({
        id,
        kind: 'token_snapshot',
        summary: 'total=' + numberFormat(total.total_tokens) + ', input=' + numberFormat(total.input_tokens) + ', output=' + numberFormat(total.output_tokens),
        timeLabel,
        chips: ['tokens']
      });
      return;
    }

    if (item.type === 'response_item' && item.payload && item.payload.type === 'function_call') {
      const args = parseArguments(item.payload.arguments);
      const tool = item.payload.name || 'unknown';
      const command = args.cmd || args.command || args.bash_command || '';
      callById.set(item.payload.call_id, { tool, args, command });

      if (command) {
        commandOrder += 1;
        const run = {
          id: item.payload.call_id,
          order: commandOrder,
          command,
          primaryCommand: primaryCommand(command),
          channel: tool,
          timeLabel,
          exitCode: null,
          outputPreview: '',
          sessionId: '',
          status: 'started',
          statusClass: ''
        };
        commandRuns.push(run);
        runByCallId.set(item.payload.call_id, run);
      }

      events.push({
        id,
        kind: 'tool_call',
        summary: command ? shortMultiline(command, 420) : shortText(JSON.stringify(args), 240),
        timeLabel,
        chips: command ? [tool, primaryCommand(command)] : [tool]
      });
      return;
    }

    if (item.type === 'response_item' && item.payload && item.payload.type === 'function_call_output') {
      const call = callById.get(item.payload.call_id) || {};
      const outputText = Array.isArray(item.payload.output)
        ? JSON.stringify(item.payload.output).slice(0, 600)
        : String(item.payload.output || '');
      const exitCode = parseExitCode(outputText);
      const sessionId = parseSessionId(outputText);
      let run = runByCallId.get(item.payload.call_id) || null;

      if (!run && call.tool === 'write_stdin' && call.args && call.args.session_id) {
        run = runBySession.get(String(call.args.session_id)) || null;
      }

      if (run) {
        if (sessionId && !run.sessionId) {
          run.sessionId = sessionId;
          runBySession.set(sessionId, run);
        }
        if (exitCode !== null) {
          run.exitCode = exitCode;
        }
        if (outputText) {
          run.outputPreview = shortMultiline(outputText, 520);
        }
        const state = statusFromExit(run.exitCode, sessionId, outputText, false);
        run.status = state.label;
        run.statusClass = state.css;
      }

      events.push({
        id,
        kind: 'tool_result',
        summary: shortMultiline(outputText, 460),
        timeLabel,
        chips: [call.tool || 'tool_result'].concat(exitCode !== null ? ['exit ' + exitCode] : sessionId ? ['session ' + sessionId] : [])
      });
    }
  });

  commandRuns.forEach((run) => {
    if (run.status === 'started') {
      const state = statusFromExit(run.exitCode, '', run.outputPreview, false);
      run.status = state.label;
      run.statusClass = state.css;
    }
  });
  const channelFamilies = toBarRows([
    { label: 'thought entries', value: thoughtEntries.length },
    { label: 'command runs', value: commandRuns.length },
    { label: 'tool results', value: events.filter((event) => event.kind === 'tool_result').length },
    { label: 'token snapshots', value: events.filter((event) => event.kind === 'token_snapshot').length },
    { label: 'final responses', value: finalResponses.length }
  ]);

  return finalizeTrace({
    side,
    kind: 'codex_jsonl',
    formatLabel: 'Codex JSONL',
    description: "Codex CLI's session .jsonl",
    fileName,
    filePath,
    taskPrompt: userPrompt,
    events,
    thoughtEntries,
    commandRuns,
    finalResponses,
    tokenRows: tokenRowsFromTotals(latestTokens),
    metrics: [
      { label: 'Events', value: numberFormat(events.length), sub: 'normalized event records' },
      { label: 'Thoughts', value: numberFormat(thoughtEntries.length), sub: 'agent commentary entries' },
      { label: 'Commands', value: numberFormat(commandRuns.length), sub: 'shell commands reconstructed from tool calls' },
      { label: 'Token total', value: latestTokens ? numberFormat(latestTokens.total_tokens) : 'n/a', sub: 'latest token snapshot if present' }
    ],
    channelFamilies
  });
}

function normalizeRawResponses(text, fileName, filePath, side) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const events = [];
  const thoughtEntries = [];
  const commandRuns = [];
  const finalResponses = [];
  let thoughtOrder = 0;
  let commandOrder = 0;
  let finalOrder = 0;
  let extractedFrames = 0;
  let emptyFrames = 0;
  let taskPrompt = '';

  lines.forEach((line, lineIndex) => {
    const outer = safeJsonParse(line);
    if (!outer || typeof outer !== 'object') {
      return;
    }
    const timeLabel = formatTimestamp(outer.timestamp || '');
    if (outer.event !== 'raw_text') {
      return;
    }
    const frames = splitConcatenatedJsonObjects(outer.raw_text);
    frames.forEach((frame, frameIndex) => {
      const idBase = side + '-raw-' + lineIndex + '-' + frameIndex;
      const hasThought = !!String(frame.thought || '').trim();
      const hasCommand = !!String(frame.bash_command || '').trim();
      const hasFinal = !!String(frame.final_response || '').trim();
      if (!hasThought && !hasCommand && !hasFinal) {
        emptyFrames += 1;
        return;
      }
      extractedFrames += 1;
      if (hasThought) {
        thoughtOrder += 1;
        const textBody = shortMultiline(frame.thought, 520);
        thoughtEntries.push({
          id: idBase + '-thought',
          order: thoughtOrder,
          text: textBody,
          timeLabel,
          chips: ['attempt ' + (outer.attempt || 'n/a')]
        });
        events.push({
          id: idBase + '-thought-event',
          kind: 'thought',
          summary: textBody,
          timeLabel,
          chips: ['attempt ' + (outer.attempt || 'n/a')]
        });
        if (!taskPrompt && /task|search|goal/i.test(textBody)) {
          taskPrompt = textBody;
        }
      }
      if (hasCommand) {
        commandOrder += 1;
        const command = String(frame.bash_command || '').trim();
        const state = statusFromExit(null, '', '', frame.done === true);
        commandRuns.push({
          id: idBase + '-command',
          order: commandOrder,
          command,
          primaryCommand: primaryCommand(command),
          channel: 'bash_command',
          timeLabel,
          exitCode: null,
          outputPreview: hasFinal ? shortMultiline(frame.final_response, 320) : '',
          status: state.label,
          statusClass: state.css
        });
        events.push({
          id: idBase + '-command-event',
          kind: 'command',
          summary: shortMultiline(command, 460),
          timeLabel,
          chips: ['attempt ' + (outer.attempt || 'n/a'), primaryCommand(command)]
        });
      }
      if (hasFinal) {
        finalOrder += 1;
        const responseText = shortMultiline(frame.final_response, 520);
        finalResponses.push({ id: idBase + '-final', order: finalOrder, text: responseText, timeLabel });
        events.push({
          id: idBase + '-final-event',
          kind: 'final_response',
          summary: responseText,
          timeLabel,
          chips: ['done=' + Boolean(frame.done)]
        });
      }
    });
  });

  const channelFamilies = toBarRows([
    { label: 'thought entries', value: thoughtEntries.length },
    { label: 'command frames', value: commandRuns.length },
    { label: 'final responses', value: finalResponses.length },
    { label: 'outer lines', value: lines.length },
    { label: 'empty frames dropped', value: emptyFrames }
  ]);

  return finalizeTrace({
    side,
    kind: 'raw_response_jsonl',
    formatLabel: 'Raw Response JSONL',
    description: "Webwright agent's raw_responses.jsonl",
    fileName,
    filePath,
    taskPrompt,
    events,
    thoughtEntries,
    commandRuns,
    finalResponses,
    tokenRows: [{ label: 'availability', value: 'not recorded' }],
    metrics: [
      { label: 'Outer lines', value: numberFormat(lines.length), sub: 'top-level raw_text records' },
      { label: 'Frames', value: numberFormat(extractedFrames), sub: 'embedded JSON frames extracted from raw_text' },
      { label: 'Thoughts', value: numberFormat(thoughtEntries.length), sub: 'inner thought strings' },
      { label: 'Commands', value: numberFormat(commandRuns.length), sub: 'inner bash_command strings' }
    ],
    channelFamilies
  });
}

function normalizeTrace(text, fileName, filePath, side) {
  const format = detectFormat(text);
  if (!format) {
    throw new Error('Only Codex JSONL and raw response JSONL are supported here');
  }
  if (format === 'codex_jsonl') {
    return normalizeCodex(text, fileName, filePath, side);
  }
  return normalizeRawResponses(text, fileName, filePath, side);
}

const app = Vue.createApp({
  data() {
    return {
      activeView: 'summary',
      traceTab: 'all',
      dragTarget: null,
      left: null,
      right: null,
      errors: { left: '', right: '' }
    };
  },
  computed: {
    slots() {
      return [
        { key: 'left', title: 'Trace A', subtitle: 'Load either the raw response JSONL or the Codex JSONL on this side.' },
        { key: 'right', title: 'Trace B', subtitle: 'Load the other JSONL trace here for direct comparison.' }
      ];
    },
    bothLoaded() {
      return !!(this.left && this.right);
    },
    leftTrace() {
      return this.left;
    },
    rightTrace() {
      return this.right;
    },
    detailTabs() {
      return [
        { label: 'Thoughts', value: 'thoughts' },
        { label: 'Commands', value: 'commands' },
        { label: 'All', value: 'all' }
      ];
    },
    comparisonRows() {
      if (!this.bothLoaded) {
        return [];
      }
      return [
        {
          label: 'Format',
          left: this.left.formatLabel,
          right: this.right.formatLabel
        },
        {
          label: 'Thought entries',
          left: numberFormat(this.left.thoughtEntries.length),
          right: numberFormat(this.right.thoughtEntries.length)
        },
        {
          label: 'Command runs',
          left: numberFormat(this.left.commandRuns.length),
          right: numberFormat(this.right.commandRuns.length)
        },
        {
          label: 'Final responses',
          left: numberFormat(this.left.finalResponses.length),
          right: numberFormat(this.right.finalResponses.length)
        },
        {
          label: 'Top command families',
          left: this.left.commandFamilies.map((row) => row.label + ' ' + row.value).join(', '),
          right: this.right.commandFamilies.map((row) => row.label + ' ' + row.value).join(', ')
        },
        {
          label: 'Task hint',
          left: this.left.taskPrompt || 'n/a',
          right: this.right.taskPrompt || 'n/a'
        }
      ];
    }
  },
  methods: {
    traceBySide(side) {
      return this[side];
    },
    errorBySide(side) {
      return this.errors[side];
    },
    clearTrace(side) {
      this[side] = null;
      this.errors[side] = '';
    },
    async handleFileInput(side, event) {
      const file = event.target.files && event.target.files[0];
      if (!file) {
        return;
      }
      await this.loadFile(side, file);
      event.target.value = '';
    },
    async handleDrop(side, event) {
      this.dragTarget = null;
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (!file) {
        return;
      }
      await this.loadFile(side, file);
    },
    async loadFile(side, file) {
      this.errors[side] = '';
      try {
        const text = await file.text();
        this[side] = normalizeTrace(text, file.name, file.path || '', side);
      } catch (error) {
        this[side] = null;
        this.errors[side] = error && error.message ? error.message : 'Failed to parse file';
      }
    },
    filteredEvents(trace) {
      if (!trace) {
        return [];
      }
      return trace.events.filter((event) => event.kind !== 'token_snapshot');
    }
  }
});

window.__traceJsonlCompareVm = app.mount('#app');
