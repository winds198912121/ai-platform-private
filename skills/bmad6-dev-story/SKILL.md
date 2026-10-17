---
name: bmad6-dev-story
description: "受入テストを先に書き、実装し、別観点でレビューする BMAD v6 の実装ワークフローです。モジュール開発段階の主軸手順として使用します。Use when implementing a slice whose acceptance tests must exist before the code. 対象外：設計判断の変更（correct-course で扱う）。"
metadata:
  stage: development
  tech: ""
  label: "BMAD v6 · 実装（create-story → TEA atdd → dev-story → code-review）"
---

# BMAD v6 · 実装（create-story → TEA atdd → dev-story → code-review）

## Overview
ストーリーを確定 → 受入テスト（ATDD）を先に書く → 実装 → レビューの順で、依存モジュールは mock せず実コードを import して使います。曖昧点は推測で埋めず correct-course で要件側に戻します。（BMAD Method v6 本家ワークフローの手順を本プラットフォーム向けに要約したもの。原典：docs.bmad-method.org）

## When to Use
- 依存が承認済みのスライスを実装するとき。
- 担当する要件 ID の原文制約（桁数・コード値・固定長）を実装・検証するとき。
- 対象外：要件やアーキテクチャの変更判断。

## Core Process
1. **create-story**：担当 req_ids の原文抜粋と受入基準を確認し、範囲を固定する。
2. **TEA atdd**：受入基準から失敗するテストを先に書く（業務ルール・境界値・コード値）。
3. **dev-story**：テストを通す最小の実装。依存モジュールは相対パスで import し、再実装しない。
4. **code-review**：要件 ID ごとの充足、エラー処理、命名、重複を確認する。曖昧点は **correct-course** で起票する。

## Common Rationalizations
| 言い訳 | 事実 |
|---|---|
| 「テストは実装の後で書く」 | 後から書いたテストは実装をなぞるだけで業務を検証しない。 |
| 「依存先が未完成なので mock で進める」 | mock 相手の承認は統合時に崩れる。依存の承認を待つ。 |

## Red Flags
- テストが関数の戻り値の形だけを見ている。
- 依存モジュールと同じ処理を自前で再実装している。
- 曖昧点を推測で実装し、どこにも記録していない。

## Verification
- [ ] 担当 req_ids ごとに少なくとも 1 件のテストがある。
- [ ] 受入テストが実装より先に存在した。
- [ ] 依存モジュールを import して使っている。
- [ ] 曖昧点が起票されているか、無いことを確認した。
