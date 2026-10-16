---
name: dev-java-struts
description: "実行モジュールは JDK 標準ライブラリだけを使い、javac / java で実際に検証します。Struts2 Action / Result と Servlet API は設計・デプロイ文書の対象とし、プラットフォームの実行条件を優先します。 Struts2 + JDBC の Action / Service / DAO、SQL、トランザクション、OGNL、既存システムと CVE 対応を扱うとき。 対象外：Spring Boot（dev-java-springboot）、Node.js（dev-nodejs）、文書のみの作業。"
metadata:
  stage: development
  tech: java-struts
  label: "Java / Struts2 + JDBC 開発規約"
---

# Java / Struts2 + JDBC 開発規約

## Overview
実行モジュールは JDK 標準ライブラリだけを使い、javac / java で実際に検証します。Struts2 Action / Result と Servlet API は設計・デプロイ文書の対象とし、プラットフォームの実行条件を優先します。

## When to Use
- Struts2 + JDBC の Action / Service / DAO、SQL、トランザクション、OGNL、既存システムと CVE 対応を扱うとき。
- 対象外：Spring Boot（dev-java-springboot）、Node.js（dev-nodejs）、文書のみの作業。

## Core Process
- ソースは src/main/java/<layer>/、テストは src/test/java/<layer>/ に置き、main + check と tests/pass/fail を出力し、失敗時は非ゼロで終了します。
- Action は引数取得・検証・結果選択、Service は業務とトランザクション、DAO は SQL とマッピングを担当します。Action に SQL と業務ルールを書きません。
- Action は要求ごとに作られますが、可変インスタンスフィールドで Service / DAO や並行状態を保持しません。要求をまたぐ情報は request / session で扱います。
- SQL は PreparedStatement とバインド引数を使います。動的な列・並び順は列挙定数の許可リストに限定し、文字列連結で入力を SQL に組み込みません。
- 1 業務操作を Service 内の 1 接続・1 トランザクションで扱います。setAutoCommit(false) と commit は上位で管理し、DAO が独自に commit しません。
- POST-Redirect-GET で再送を防ぎ、ページ分割・並び順の範囲を明示的に検証します。
- Action.validate() または XML validator で検証し、失敗時はフィールドへ戻して日本語または English のエラーを示します。例外を通常制御に使いません。
- <s:property> をエスケープし、利用者入力を OGNL の %{...} に連結しません。JSP は表示と反復のみを担当します。
- CVE-2017-5638、CVE-2018-11776 などの履歴を踏まえ、Struts2 の具体的なバージョンを固定し、公式告知を追跡し、不要プラグインと開発モードを無効化します。
- Service / DAO はメモリ DB または接続スタブ、Action は最小スタブで引数→結果コードと再表示を検証し、具体的なエラーを確認します。

## Common Rationalizations
| よくある説明 | 確認すべき事実 |
|---|---|
| Action にまとめると簡単 | 入口・業務・SQL をそれぞれの層へ分離します。 |
| 動的 SQL は文字列連結でよい | 値はバインドし、列と並び順は許可リストに限定します。 |
| 各 DAO が commit すればよい | Service が業務単位の接続とトランザクションを管理します。 |
| 社内システムなので OGNL の検証は不要 | 入力連結を禁止し、出力をエスケープします。 |
| 既存 Struts2 は今動いていればよい | バージョン固定、公式告知の確認、不要機能の無効化が必要です。 |

## Red Flags
- 実行モジュールに Struts / Servlet の未提供依存があります。
- Action の SQL、可変要求状態、文字列連結 SQL、DAO の独立 commit があります。
- OGNL への入力連結、未エスケープ JSP、開発モードや不要プラグインがあります。

## Verification
- [ ] ソースは src/main/java/<layer>/、テストは src/test/java/<layer>/ に置き、main + check と tests/pass/fail を出力し、失敗時は非ゼロで終了します。
- [ ] Action は引数取得・検証・結果選択、Service は業務とトランザクション、DAO は SQL とマッピングを担当します。Action に SQL と業務ルールを書きません。
- [ ] Action は要求ごとに作られますが、可変インスタンスフィールドで Service / DAO や並行状態を保持しません。要求をまたぐ情報は request / session で扱います。
- [ ] SQL は PreparedStatement とバインド引数を使います。動的な列・並び順は列挙定数の許可リストに限定し、文字列連結で入力を SQL に組み込みません。
- [ ] 1 業務操作を Service 内の 1 接続・1 トランザクションで扱います。setAutoCommit(false) と commit は上位で管理し、DAO が独自に commit しません。
- [ ] POST-Redirect-GET で再送を防ぎ、ページ分割・並び順の範囲を明示的に検証します。
- [ ] Action.validate() または XML validator で検証し、失敗時はフィールドへ戻して日本語または English のエラーを示します。例外を通常制御に使いません。
- [ ] <s:property> をエスケープし、利用者入力を OGNL の %{...} に連結しません。JSP は表示と反復のみを担当します。
- [ ] CVE-2017-5638、CVE-2018-11776 などの履歴を踏まえ、Struts2 の具体的なバージョンを固定し、公式告知を追跡し、不要プラグインと開発モードを無効化します。
- [ ] Service / DAO はメモリ DB または接続スタブ、Action は最小スタブで引数→結果コードと再表示を検証し、具体的なエラーを確認します。
