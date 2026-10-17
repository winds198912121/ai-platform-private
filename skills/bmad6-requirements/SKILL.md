---
name: bmad6-requirements
description: "既存仕様・入力資料を取り込み、ID 付きの FR / NFR を持つ PRD にまとめる BMAD v6 の要件ワークフローです。要件定義段階の主軸手順として使用します。Use when turning input specifications into an ID-traced PRD. 対象外：発散型のアイデア出し。"
metadata:
  stage: requirements
  tech: ""
  label: "BMAD v6 · 要件（document-project → create-product-brief → create-prd）"
---

# BMAD v6 · 要件（document-project → create-product-brief → create-prd）

## Overview
入力資料を要約で丸めず、既存仕様の取り込み → プロダクト概要 → PRD の順に、機能要件（FR）と非機能要件（NFR）へ安定した ID を付けて固定します。（BMAD Method v6 本家ワークフローの手順を本プラットフォーム向けに要約したもの。原典：docs.bmad-method.org）

## When to Use
- 入力資料（仕様書・データ定義・画面帳票）があり、それを要件定義書に落とすとき。
- 要件台帳（機能・テーブル・IF・帳票 ID）を下流の WBS とテストに引き継ぐとき。
- 対象外：ゼロからの発想支援（ブレインストーミング）。

## Core Process
1. **document-project**：入力資料の構成と既存 ID（機能・テーブル・IF・帳票）を一覧化し、要件台帳と突き合わせる。台帳に無い ID を作らない。
2. **create-product-brief**：目的・利用者・範囲・制約（稼働時間、RPO、閉域など）を 1 ページで固定する。
3. **create-prd**：台帳 ID ごとに FR を記述し、ID の無い要件だけ FR-/NFR- を新設する。各 FR に受入基準（数値・境界・コード値）を付ける。
4. 対象外・未決事項を独立節にまとめ、決定者を書く。推測で埋めない。

## Common Rationalizations
| 言い訳 | 事実 |
|---|---|
| 「全部書くと長いので要約する」 | 要約は要件の消失。ID 単位で書き、長さは台帳で吸収する。 |
| 「ID は後で振る」 | ID の無い要件は WBS・テストで追跡できない。最初に固定する。 |

## Red Flags
- 台帳の ID 数と PRD に出てくる ID 数が大きく違う。
- 受入基準が「正しく動く」「使いやすい」など判定不能。
- NFR（稼働時間・RPO・性能・セキュリティ）に数値が無い。

## Verification
- [ ] 台帳の全 ID が PRD のどこかで参照されている。
- [ ] 新設した FR/NFR に重複番号が無い。
- [ ] 各 FR に判定可能な受入基準が 1 件以上ある。
- [ ] 対象外と未決事項に決定者が書かれている。
