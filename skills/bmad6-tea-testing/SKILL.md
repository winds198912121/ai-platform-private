---
name: bmad6-tea-testing
description: "要件 ID と対応づけたテスト設計・自動化・トレース・非機能評価を行う BMAD v6 の TEA ワークフローです。結合テスト段階の主軸手順として使用します。Use when proving requirement coverage with automated tests on every merge. 対象外：単体テストの書き方。"
metadata:
  stage: testing
  tech: ""
  label: "BMAD v6 · TEA テスト（test-design / automate / trace / nfr-assess / test-review）"
---

# BMAD v6 · TEA テスト（test-design / automate / trace / nfr-assess / test-review）

## Overview
結合テストを最後の一斉テストにせず、マージごとに自動で走るテストとして設計し、要件 ID ごとの合否と未検証 ID をトレース表で示します。（BMAD Method v6 本家ワークフローの手順を本プラットフォーム向けに要約したもの。原典：docs.bmad-method.org）

## When to Use
- スライスが main に入るたびに結合・E2E を回すとき。
- 要件カバレッジ表とテスト終了条件を示すとき。
- 対象外：モジュール内部の単体テスト設計。

## Core Process
1. **test-design**：要件 ID ごとにテスト観点・データ・期待結果を決める。
2. **automate**：結合・E2E を CI で自動実行できる形にする。
3. **trace**：要件 ID → テスト → 結果の表を作り、未検証 ID を明示する。
4. **nfr-assess / test-review**：性能・セキュリティ・稼働要件を数値で評価し、テスト自体の品質を見直す。

## Common Rationalizations
| 言い訳 | 事実 |
|---|---|
| 「全部できてから結合テスト」 | 最後の一斉テストでは原因の切り分けができない。マージごとに回す。 |
| 「テストが全部緑なので完了」 | 緑でも検証していない要件 ID があれば未完了。トレース表で示す。 |

## Red Flags
- トレース表に未検証 ID があるのに「完了」としている。
- NFR に数値の判定基準が無い。
- テストが CI ではなく手作業でしか走らない。

## Verification
- [ ] 全要件 ID に合否または「未検証」の記載がある。
- [ ] 結合・E2E が CI でマージごとに走る。
- [ ] NFR が数値基準で評価されている。
- [ ] テスト終了条件が明記されている。
