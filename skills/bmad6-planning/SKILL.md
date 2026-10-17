---
name: bmad6-planning
description: "要件 ID を依存順の縦割りスライス（Epic / Story）に分け、着手可否を確認して計画する BMAD v6 の計画ワークフローです。WBS 段階の主軸手順として使用します。Use when splitting a large system into dependency-ordered vertical slices. 対象外：技術レイヤー別の横割り分割。"
metadata:
  stage: wbs
  tech: ""
  label: "BMAD v6 · 計画（create-epics-and-stories → check-implementation-readiness → sprint-planning）"
---

# BMAD v6 · 計画（create-epics-and-stories → check-implementation-readiness → sprint-planning）

## Overview
技術レイヤーで横に切らず、機能 ID 単位で画面 → API → DB → テストを通す縦割りスライスに分け、依存順（マスタ → 台帳 → 業務処理 → 締め → 帳票）に並べます。（BMAD Method v6 本家ワークフローの手順を本プラットフォーム向けに要約したもの。原典：docs.bmad-method.org）

## When to Use
- 機能 ID が数十あり、1 回の流しでは収まらないとき。
- モジュール間の依存（deps）を明示してスケジューラに渡すとき。
- 対象外：単一モジュールの小規模ツール。

## Core Process
1. **create-epics-and-stories**：各 Epic に担当する台帳 ID（req_ids）と依存（deps）を付ける。全 ID がどこかの Epic に入る。
2. **check-implementation-readiness**：契約・スキーマ・未決事項が揃っているか確認し、揃わない Epic は保留にする。
3. **sprint-planning**：依存グラフの順に着手順を決める。
4. 受入基準には原文の制約（テーブル ID・項目・桁数・コード値）を書く。

## Common Rationalizations
| 言い訳 | 事実 |
|---|---|
| 「core / domain / infra で分ければ並行できる」 | 横割りは上位が mock 相手になり、統合問題が結合テストで噴出する。 |
| 「依存は実装中に分かる」 | 依存の無い計画では上位モジュールが先に承認されてしまう。 |

## Red Flags
- 依存（deps）が空の Epic ばかり。
- 未割当の台帳 ID がある。
- 受入基準が実装詳細（関数の戻り値）だけで業務ルールが無い。

## Verification
- [ ] 台帳の全 ID がいずれかの Epic に割り当てられている。
- [ ] 各 Epic の deps が前方の Epic だけを指す（循環なし）。
- [ ] 各 Task の受入基準に業務上の判定条件がある。
- [ ] 着手順が依存グラフと一致している。
