---
name: dev-sap-cap-rap
description: "CAP Java のコードは JDK 標準ライブラリで実行し、CDS は db/schema.cds と srv/<name>-service.cds を実際に生成します。構造検証と cds compile の実コンパイルを区別し、実行条件を優先します。 CAP の CDS エンティティ、service、handler、データアクセス、RAP の behavior definition / implementation を生成・レビューするとき。 CAP と RAP のエラー、フィールド、必須項目、状態遷移の一致を確認するとき。 対象外：SAP 以外の共通開発規約、一般的な配置・レビュー（dev-code-layout / development-review-checklist）。"
metadata:
  stage: development
  tech: sap-cap-rap
  label: "SAP CAP / RAP 開発規約"
---

# SAP CAP / RAP 開発規約

## Overview
CAP Java のコードは JDK 標準ライブラリで実行し、CDS は db/schema.cds と srv/<name>-service.cds を実際に生成します。構造検証と cds compile の実コンパイルを区別し、実行条件を優先します。

## When to Use
- CAP の CDS エンティティ、service、handler、データアクセス、RAP の behavior definition / implementation を生成・レビューするとき。
- CAP と RAP のエラー、フィールド、必須項目、状態遷移の一致を確認するとき。
- 対象外：SAP 以外の共通開発規約、一般的な配置・レビュー（dev-code-layout / development-review-checklist）。

## Core Process
- Java ソースとテストは src/main/java/<layer>/ と src/test/java/<layer>/ に置きます。CDS の各エンティティには key を付け、cds-dk がある場合だけ実際の cds compile として報告します。フレームワーク注釈は設計・デプロイ文書に記載します。
- 先に db/ の CDS で型、key、Association / Composition の方向を定義し、cuid / managed または unmanaged の選択理由を記載します。
- 金額・数量には Decimal と通貨・単位の意味を付け、@Semantics.amount.currencyCode: currency など対応項目を揃えます。float は使いません。
- srv/service.cds は必要な entity と action / function だけを公開し、as select from ... { } でフィールドを明示して * で全表を出しません。
- on / before / after handler は検証と副作用の調整に限定し、業務ロジックは lib/domain の純粋関数に置きます。
- cds.ql またはパラメーター化したクエリを使い、一括取得で N+1 を防ぎます。SQL を文字列連結しません。
- 認可は @requires / @restrict で宣言し、handler でロールを個別判定しません。req.reject(code, message) で安定したエラーを返します。
- Draft を使うエンティティ、@odata.draft.enabled、保存時・有効化時の検証点と有効化の時機を定義します。
- RAP は managed / unmanaged、association、validation、determination、action を含む behavior definition と implementation を対で提出します。書き込みは MODIFY ENTITIES など EML に限定し、基底表へ直接 INSERT / UPDATE しません。検証は validations、派生値は determinations、メッセージは深刻度付き %msg とします。
- CAP と RAP のエラーコード、フィールド名、必須条件、状態遷移を揃え、差異は理由付き許可リストへ記録します。
- CAP は cds.test またはサービス単体テスト、RAP は ABAP Unit で正常・拒否経路を確認し、拒否時のエラーコードも検証します。

## Common Rationalizations
| よくある説明 | 確認すべき事実 |
|---|---|
| CDS は文書内の例だけでよい | 実ファイルと key が必要です。構造検証をコンパイル成功として報告しません。 |
| handler へすべて実装する | handler は調整、業務ルールは純粋なドメイン処理へ分離します。 |
| RAP でも基底表へ直接更新する | EML を使い、validation / determination / action の責務を維持します。 |
| CAP と RAP の差異は無視してよい | 契約を一致させ、差異は理由とともに登録します。 |

## Red Flags
- 実 CDS ファイル、key、behavior の対になる実装が不足しています。
- 未提供の CAP 依存、長い handler、連結 SQL、N+1、手書き認可があります。
- 基底表への直接書き込み、Draft の未定義、CAP / RAP の未登録の差異があります。

## Verification
- [ ] Java ソースとテストは src/main/java/<layer>/ と src/test/java/<layer>/ に置きます。CDS の各エンティティには key を付け、cds-dk がある場合だけ実際の cds compile として報告します。フレームワーク注釈は設計・デプロイ文書に記載します。
- [ ] 先に db/ の CDS で型、key、Association / Composition の方向を定義し、cuid / managed または unmanaged の選択理由を記載します。
- [ ] 金額・数量には Decimal と通貨・単位の意味を付け、@Semantics.amount.currencyCode: currency など対応項目を揃えます。float は使いません。
- [ ] srv/service.cds は必要な entity と action / function だけを公開し、as select from ... { } でフィールドを明示して * で全表を出しません。
- [ ] on / before / after handler は検証と副作用の調整に限定し、業務ロジックは lib/domain の純粋関数に置きます。
- [ ] cds.ql またはパラメーター化したクエリを使い、一括取得で N+1 を防ぎます。SQL を文字列連結しません。
- [ ] 認可は @requires / @restrict で宣言し、handler でロールを個別判定しません。req.reject(code, message) で安定したエラーを返します。
- [ ] Draft を使うエンティティ、@odata.draft.enabled、保存時・有効化時の検証点と有効化の時機を定義します。
- [ ] RAP は managed / unmanaged、association、validation、determination、action を含む behavior definition と implementation を対で提出します。書き込みは MODIFY ENTITIES など EML に限定し、基底表へ直接 INSERT / UPDATE しません。検証は validations、派生値は determinations、メッセージは深刻度付き %msg とします。
- [ ] CAP と RAP のエラーコード、フィールド名、必須条件、状態遷移を揃え、差異は理由付き許可リストへ記録します。
- [ ] CAP は cds.test またはサービス単体テスト、RAP は ABAP Unit で正常・拒否経路を確認し、拒否時のエラーコードも検証します。
