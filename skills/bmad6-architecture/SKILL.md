---
name: bmad6-architecture
description: "実スタック・データモデル・API 契約・テスト基盤と CI を決める BMAD v6 のアーキテクチャワークフローです。アーキテクチャ設計段階の主軸手順として使用します。Use when fixing the real stack, contracts and CI before implementation starts. 対象外：個別機能の実装詳細。"
metadata:
  stage: architecture
  tech: ""
  label: "BMAD v6 · アーキテクチャ（create-architecture + TEA framework / ci）"
---

# BMAD v6 · アーキテクチャ（create-architecture + TEA framework / ci）

## Overview
宣言したスタックが実際に動くこと（ウォーキングスケルトン）を前提に、DB スキーマ・API 契約・共通型を先に公開し、テスト基盤と CI を同時に決めます。（BMAD Method v6 本家ワークフローの手順を本プラットフォーム向けに要約したもの。原典：docs.bmad-method.org）

## When to Use
- 複数モジュールが並行開発され、契約（スキーマ・API）を先に固定する必要があるとき。
- DB スキーマを仕様書のテーブル定義から作るとき。
- 対象外：モジュール内部の実装方式。

## Core Process
1. **create-architecture**：スタック・レイヤー・境界・ADR を決める。宣言スタックと実行環境が一致するか確認する。
2. データモデルは台帳のテーブル ID と 1 対 1。DDL は仕様書から機械生成し、手書きしない。
3. API 契約（OpenAPI 等）と共通型を公開し、下流はこれだけを参照する。
4. **TEA framework / ci**：テストフレームワークと CI（マージごとの結合・E2E）を決める。

## Common Rationalizations
| 言い訳 | 事実 |
|---|---|
| 「スタックは目標として書いておけばよい」 | 実行環境と違うスタックは誰も強制しない。動く骨組みで確認する。 |
| 「DDL はモデルに書かせる」 | 決定的に変換できるものを LLM に任せると桁・型がずれる。 |

## Red Flags
- 宣言スタックと実際の実行形式（依存なし ESM 等）が違う。
- テーブル定義に台帳の ID が無い。
- CI がなく、結合テストが最後にまとめて行われる計画。

## Verification
- [ ] 宣言スタックで最小構成が起動・テストできる。
- [ ] 全テーブル ID がデータモデルに対応し、DDL が生成手順で再現できる。
- [ ] API 契約と共通型が公開されている。
- [ ] CI でマージごとに結合テストが走る。
