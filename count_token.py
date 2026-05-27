#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import tiktoken


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Count turn-by-turn tokens from Webwright raw_text JSONL traces using only the given JSONL files."
        )
    )
    parser.add_argument("paths", nargs="+", help="One or more JSONL trace files to inspect.")
    parser.add_argument(
        "--encoding",
        default="o200k_base",
        help="tiktoken encoding name to use. Default: o200k_base",
    )
    parser.add_argument(
        "--model",
        help="Optional OpenAI model name. If set, its tiktoken encoding is used unless --encoding is also set.",
    )
    return parser


def get_encoder(*, encoding_name: str, model_name: str | None):
    if model_name and encoding_name == "o200k_base":
        try:
            return tiktoken.encoding_for_model(model_name), f"{tiktoken.encoding_for_model(model_name).name} (from model {model_name})"
        except KeyError:
            pass
    return tiktoken.get_encoding(encoding_name), encoding_name


def split_concatenated_json_objects(raw_text: str) -> list[tuple[str, dict]]:
    decoder = json.JSONDecoder()
    frames: list[tuple[str, dict]] = []
    index = 0
    while index < len(raw_text):
        while index < len(raw_text) and raw_text[index].isspace():
            index += 1
        if index >= len(raw_text):
            break
        parsed, end = decoder.raw_decode(raw_text, index)
        if not isinstance(parsed, dict):
            raise ValueError(f"Expected JSON object inside raw_text at offset {index}.")
        frames.append((raw_text[index:end], parsed))
        index = end
    return frames


def count_tokens(encoder, text: str) -> int:
    if not text:
        return 0
    return len(encoder.encode(text))


def action_text(frame: dict) -> tuple[str, str]:
    for field in ("bash_command", "python_code", "command"):
        value = str(frame.get(field, "") or "").strip()
        if value:
            return field, value
    return "", ""


def frame_kind(frame: dict) -> str:
    field, _ = action_text(frame)
    if field == "bash_command":
        return "bash"
    if field == "python_code":
        return "python"
    if str(frame.get("final_response", "") or "").strip():
        return "final"
    return "text"


@dataclass
class TurnStats:
    turn: int
    line: int
    frame: int
    attempt: int | str
    timestamp: str
    kind: str
    input_est_tokens: int
    output_tokens: int
    thought_tokens: int
    action_tokens: int
    final_tokens: int
    cumulative_input_est_tokens: int
    cumulative_output_tokens: int


def parse_trace(path: Path, encoder) -> list[TurnStats]:
    turns: list[TurnStats] = []
    visible_history: list[str] = []
    cumulative_input = 0
    cumulative_output = 0
    turn_number = 0

    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            outer = json.loads(stripped)
            raw_text = str(outer.get("raw_text", "") or "")
            if not raw_text:
                continue

            for frame_number, (frame_text, frame) in enumerate(split_concatenated_json_objects(raw_text), start=1):
                turn_number += 1
                thought = str(frame.get("thought", "") or "")
                _, action = action_text(frame)
                final_response = str(frame.get("final_response", "") or "")
                input_est = count_tokens(encoder, "\n\n".join(visible_history))
                output = count_tokens(encoder, frame_text)
                thought_count = count_tokens(encoder, thought)
                action_count = count_tokens(encoder, action)
                final_count = count_tokens(encoder, final_response)
                cumulative_input += input_est
                cumulative_output += output
                turns.append(
                    TurnStats(
                        turn=turn_number,
                        line=line_number,
                        frame=frame_number,
                        attempt=outer.get("attempt", ""),
                        timestamp=str(outer.get("timestamp", "") or ""),
                        kind=frame_kind(frame),
                        input_est_tokens=input_est,
                        output_tokens=output,
                        thought_tokens=thought_count,
                        action_tokens=action_count,
                        final_tokens=final_count,
                        cumulative_input_est_tokens=cumulative_input,
                        cumulative_output_tokens=cumulative_output,
                    )
                )
                visible_history.append(frame_text)

    return turns


def format_table(rows: Iterable[TurnStats]) -> str:
    headers = (
        ("turn", lambda row: str(row.turn)),
        ("att", lambda row: str(row.attempt)),
        ("kind", lambda row: row.kind),
        ("input_est", lambda row: str(row.input_est_tokens)),
        ("output", lambda row: str(row.output_tokens)),
        ("thought", lambda row: str(row.thought_tokens)),
        ("action", lambda row: str(row.action_tokens)),
        ("final", lambda row: str(row.final_tokens)),
        ("cum_in_est", lambda row: str(row.cumulative_input_est_tokens)),
        ("cum_out", lambda row: str(row.cumulative_output_tokens)),
    )
    rows = list(rows)
    widths = []
    for header, getter in headers:
        widths.append(max(len(header), *(len(getter(row)) for row in rows)) if rows else len(header))

    lines = []
    header_line = "  ".join(header.ljust(width) for (header, _), width in zip(headers, widths))
    divider = "  ".join("-" * width for width in widths)
    lines.append(header_line)
    lines.append(divider)
    for row in rows:
        lines.append(
            "  ".join(getter(row).rjust(width) if header not in {"kind"} else getter(row).ljust(width)
                      for (header, getter), width in zip(headers, widths))
        )
    return "\n".join(lines)


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    encoder, encoding_label = get_encoder(encoding_name=args.encoding, model_name=args.model)

    for raw_path in args.paths:
        path = Path(raw_path)
        turns = parse_trace(path, encoder)
        print(f"=== {path} ===")
        print(f"encoding: {encoding_label}")
        print("source: raw_text frames only")
        print("input_est: tokens in prior raw_text frames from the same file only")
        print("output: exact tokens in each raw_text JSON frame")
        print(f"turns: {len(turns)}")
        print()
        print(format_table(turns))
        print()
        if turns:
            last = turns[-1]
            print(
                "totals: "
                f"input_est={last.cumulative_input_est_tokens} "
                f"output={last.cumulative_output_tokens}"
            )
        else:
            print("totals: input_est=0 output=0")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
