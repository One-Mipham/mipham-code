"""分析准确性评测集 —— 探针即真值（原型）。

判据不是「答案听起来对不对」，而是**答案能不能由一条命令产出**。所以每个用例
携带一条 `probe`（shell 命令）与它的 `expect`（那条命令的输出）：真值不是写死在
用例里的人话，而是命令当下的读数 —— 用例因此能被自己证伪。

三种模式：

    verify     跑全部 probe，与 expect 比对（真值是否仍成立）
    questions  只吐 {id, question}，供被测代理作答
    score      读 {id, answer}，与 expect 比对，按错误形态分组

两条硬约定：

1. **零命中类用例必须带 `control`**（一条必然命中的 probe）。没有它，
   「0 个匹配」与「探针压根没读到那个文件」打印的是同一个读数。
2. **所有 probe 都钉在提交上**，不指向 HEAD。指向 HEAD 的 probe 描述的是
   「今天的树」，而用例描述的是「报告当时的主张」—— 两者一混，复核就会量到
   一个已经被修过的对象，从而把对的报告判成错的。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

CASES_FILE = Path(__file__).with_name("cases.jsonl")

# 仓库根 = mipham-code 根（本文件在 benchmarks/analysis/ 下两层）
REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Case:
    id: str
    form: str
    klass: str
    question: str
    probe: str
    match: str
    expect: str
    origin: str = ""
    cwd: str = "megasystem"
    requires: str | None = None
    control: str | None = None
    control_expect: str | None = None
    recorded_claim: str = ""
    recorded_verdict: str = ""


def load_cases(path: Path = CASES_FILE) -> list[Case]:
    cases: list[Case] = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            cases.append(Case(**json.loads(line)))
    return cases


def megasystem_root() -> Path:
    override = os.environ.get("MIPHAM_MEGASYSTEM")
    return Path(override) if override else REPO_ROOT.parent / "megasystem"


def resolve_cwd(case: Case) -> Path | None:
    """用例的工作目录；依赖缺失时返回 None（跳过，不算失败）。"""
    root = megasystem_root()
    if not root.is_dir():
        return None
    path = root / case.cwd.removeprefix("megasystem").lstrip("/")
    if not path.is_dir():
        return None
    if case.requires and not (root / case.requires).is_dir():
        return None
    return path


def run_probe(probe: str, cwd: Path) -> tuple[int, str]:
    proc = subprocess.run(
        probe,
        shell=True,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=120,
    )
    return proc.returncode, proc.stdout.strip()


_ZERO_WORDS = re.compile(r"\b(zero|none)\b|零", re.IGNORECASE)


def _first_number(text: str) -> str | None:
    cleaned = _ZERO_WORDS.sub("0", text.replace(",", "").replace("，", ""))
    found = re.search(r"-?\d+", cleaned)
    return found.group(0) if found else None


def matches(answer: str, expect: str, mode: str) -> bool:
    """判分。`digits` 取首个整数（千分位、中文「零」先归一），`contains` 取子串。"""
    answer = answer.strip()
    if mode == "digits":
        return _first_number(answer) == _first_number(expect)
    if mode == "contains":
        return expect.strip().lower() in answer.lower()
    return " ".join(answer.split()) == " ".join(expect.split())


def check(case: Case, cwd: Path) -> tuple[bool, str, str]:
    """返回 (是否成立, 观测值, 说明)。"""
    if case.control:
        rc, out = run_probe(case.control, cwd)
        if rc != 0 or not matches(out, case.control_expect or "", "digits"):
            return (
                False,
                out,
                f"正对照失败：期望 {case.control_expect}，探针输出 {out or '空'}（rc={rc}）",
            )
    rc, out = run_probe(case.probe, cwd)
    if rc != 0:
        return False, out, f"探针退出码 {rc}"
    return matches(out, case.expect, case.match), out, ""


# --------------------------------------------------------------------------- #
# verify
# --------------------------------------------------------------------------- #


def cmd_verify(cases: list[Case]) -> int:
    stale = skipped = 0
    for case in cases:
        cwd = resolve_cwd(case)
        if cwd is None:
            skipped += 1
            print(f"SKIP  {case.id}  依赖缺失（{case.requires or case.cwd}）")
            continue
        ok, out, note = check(case, cwd)
        if not ok:
            stale += 1
            print(f"STALE {case.id}  期望 {case.expect}，实测 {out or '空'}  {note}")
        else:
            print(f"ok    {case.id}  {case.form}  {out}")
    total = len(cases) - skipped
    print(
        f"\n真值成立 {total - stale}/{total}"
        + (f"（跳过 {skipped}）" if skipped else "")
    )
    return 1 if stale else 0


# --------------------------------------------------------------------------- #
# questions / score
# --------------------------------------------------------------------------- #


def cmd_questions(cases: list[Case]) -> int:
    for case in cases:
        print(
            json.dumps({"id": case.id, "question": case.question}, ensure_ascii=False)
        )
    return 0


def cmd_score(cases: list[Case], answers_path: Path) -> int:
    answers: dict[str, str] = {}
    with answers_path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            answers[str(row["id"])] = str(row.get("answer", ""))

    by_form: dict[str, list[bool]] = {}
    by_klass: dict[str, list[bool]] = {}
    wrong: list[str] = []
    skipped = 0
    for case in cases:
        if resolve_cwd(case) is None:
            skipped += 1
            continue
        answer = answers.get(case.id)
        if answer is None:
            wrong.append(f"{case.id}  未作答（期望 {case.expect}）")
            ok = False
        else:
            ok = matches(answer, case.expect, case.match)
            if not ok:
                wrong.append(
                    f"{case.id}  答「{answer}」期望「{case.expect}」（{case.form}）"
                )
        by_form.setdefault(case.form, []).append(ok)
        by_klass.setdefault(case.klass, []).append(ok)

    total = sum(len(v) for v in by_form.values())
    passed = sum(sum(v) for v in by_form.values())
    for line in wrong:
        print(f"FAIL  {line}")
    print()
    for label, bucket in (("形态", by_form), ("类别", by_klass)):
        parts = [f"{k} {sum(v)}/{len(v)}" for k, v in sorted(bucket.items())]
        print(f"按{label}：" + "  ".join(parts))
    print(f"\n准确率 {passed}/{total}" + (f"（跳过 {skipped}）" if skipped else ""))
    return 0 if passed == total else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="分析准确性评测集（探针即真值）")
    parser.add_argument("mode", choices=["verify", "questions", "score"])
    parser.add_argument(
        "answers", nargs="?", type=Path, help="score 模式：{id, answer} JSONL"
    )
    parser.add_argument("--cases", type=Path, default=CASES_FILE)
    args = parser.parse_args(argv)
    cases = load_cases(args.cases)

    if args.mode == "verify":
        return cmd_verify(cases)
    if args.mode == "questions":
        return cmd_questions(cases)
    if args.answers is None:
        parser.error("score 模式需要 answers 文件")
    return cmd_score(cases, args.answers)


if __name__ == "__main__":
    sys.exit(main())
