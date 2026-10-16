---
name: dev-code-layout
description: "設計で定めたレイヤーディレクトリへ、業務上の意味を持つ名前で直接ソースを配置します。モジュール名の追加階層や WBS 番号は使いません。 ソースの新規作成、配置先・クラス・関数・テスト名の決定、共有コードの配置判断に使用します。 対象外：レイヤー自体の再設計、SAP CAP/RAP の CDS・service・behavior 専用モデル（dev-sap-cap-rap を使用）。"
metadata:
  stage: development
  tech: ""
  label: "コード配置と命名（モジュール別サブディレクトリなし）"
---

# コード配置と命名（モジュール別サブディレクトリなし）

## Overview
設計で定めたレイヤーディレクトリへ、業務上の意味を持つ名前で直接ソースを配置します。モジュール名の追加階層や WBS 番号は使いません。

## When to Use
- ソースの新規作成、配置先・クラス・関数・テスト名の決定、共有コードの配置判断に使用します。
- 対象外：レイヤー自体の再設計、SAP CAP/RAP の CDS・service・behavior 専用モデル（dev-sap-cap-rap を使用）。

## Core Process
- Node/Python は src/<layer>/、Java は src/main/java/<layer>/ へ直接配置します。src/<layer>/m1-order-service/xxx.mjs のような階層は禁止し、違反はログに記録されます。
- order-service.mjs、OrderService.java、order_service.py のような業務名を使用し、M1 / E2 / T3 などの内部追跡番号を成果物の名前へ含めません。
- Java は PascalCase でファイル名と public クラス名を一致させ、Node は kebab-case、Python は snake_case とします。同名時は OrderRefundService など具体化し、数字接尾辞を付けません。
- 複数ファイルも同じ層に平置きします。共有処理は core/domain など下位の登録済み層に置き、未登録の shared/ や common/ を新設しません。
- テストも業務名を使い、src/test/java/<layer>/OrderServiceTest.java、test/<layer>/order-service.test.mjs、test/<layer>/order_service.test.py のように対応させます。
- mod.dir / mod.test_path_planned はプラットフォームが設計規約から算出した配置先です。そのまま使い、独自階層の追加や見た目のための移動を行いません。所属判定と保存後の自動再テストができなくなります。
- レイヤー名は ARC-01 の JSON で宣言したものだけを使い、追加前に設計書を修正します。

## Common Rationalizations
| よくある説明 | 確認すべき事実 |
|---|---|
| モジュールのサブディレクトリを作ると整う | 所属判定を妨げ、レイヤー規約違反がログに記録されます。 |
| M1 / E2 をファイル名へ付けると追跡しやすい | 内部番号は成果物に含めず、安定した業務名を使います。 |
| 同名時は数字を付ければよい | 数字より具体的な業務名を使用します。 |
| 共有コードは shared/ / common/ が適切 | 未登録の階層ではなく core/domain に置きます。 |
| 見た目のためにファイルを移動する | 所属が失われ、変更時の自動単体テストが実行できなくなります。 |

## Red Flags
- src/<layer>/<module>/xxx の追加階層があります。
- ファイル名に WBS 番号または意味のない数字接尾辞があります。
- ARC-01 にない shared/ / common/ を新設しています。
- レイヤー名が設計書の一覧にありません。
- テストの配置または業務名がソースと対応していません。

## Verification
- [ ] ソースは宣言済みレイヤー直下にあり、モジュール別サブディレクトリがありません。
- [ ] 業務名で命名し、WBS 番号と数字接尾辞がありません。
- [ ] Java のファイル名と public クラス名が一致し、Node / Python の命名規約を守っています。
- [ ] テストが対応するテストディレクトリにあり、ソースと同じ業務名です。
- [ ] 設計にないレイヤーを追加していません。
