---
name: dev-nestjs-nextjs-postgres
description: "NestJS / Next.js / PostgreSQL 16 を TypeScript で実装する規約です。exec.mjs の TypeScript プロファイル（npm 許可リスト依存・tsx + node --test・Docker の PostgreSQL）が実際に実行する条件に従います。 NestJS のサービス・コントローラ、Next.js のページ周辺ロジック、PostgreSQL リポジトリの作成・修正・レビューに使用します。 対象外：依存なし Node ESM、Java、Python。許可リスト外の依存が必要な場合は先にアーキテクチャで合意します。 Use when writing or reviewing NestJS services/controllers, Next.js page logic, or PostgreSQL repositories under the TypeScript profile."
metadata:
  stage: development
  tech: nestjs-nextjs-postgres
  label: "NestJS / Next.js / PostgreSQL 開発規約"
---

# NestJS / Next.js / PostgreSQL 開発規約

## Overview
宣言スタック「Next.js + NestJS + PostgreSQL 16」をそのまま実行します。依存はプラットフォームの許可リスト（@nestjs/*、reflect-metadata、rxjs、next、react、pg、zod など）から名前だけ要求し、バージョンと package.json・tsconfig.json・npm install はプラットフォームが管理します。単体テストは tsx + node --test、DB は Repository 層の背後に隠し、本物の PostgreSQL は Docker の postgres:16 で統合テストします。

## When to Use
- NestJS の @Injectable サービス、@Controller、DTO、モジュール構成を実装・修正するとき。
- Next.js のページ／コンポーネントから業務ロジックを切り出し、純粋関数として単体テストするとき。
- PostgreSQL へのアクセス（リポジトリ、SQL、トランザクション、マイグレーション相当の DDL）を実装・レビューするとき。
- 対象外：依存なし Node ESM（dev-nodejs）、Java、Python。許可リスト外のパッケージ（ORM、HTTP クライアント等）が必要ならアーキテクチャ（ARC-01）で先に合意し、許可リストに追加します。

## Core Process
- 依存は許可リストの名前だけをモジュール出力の deps に書きます。package.json を手で書かず、バージョンを指定せず、postinstall に頼りません（npm install は --ignore-scripts）。
- DB アクセスは必ず Repository 層を通します：インターフェース（XxxRepository）＋ InMemoryXxxRepository（単体テスト用）＋ PgXxxRepository（pg の Pool、パラメータ化 SQL $1…）。Service / Controller はインターフェースだけに依存し、pg を直接 import しません。
- NestJS はコンストラクタ注入を使い、デコレータを使うファイルの先頭で import 'reflect-metadata' を行います。インターフェースや値を注入する場合は @Inject(TOKEN) を明示します。
- 単体テストはサービスを new し InMemory リポジトリを注入します。Nest の DI コンテナや本物の DB に依存させません。
- 本物の PostgreSQL が必要なケースは test(名前, { skip: !process.env.DATABASE_URL && 'PostgreSQL unavailable' }, …) とし、CREATE TABLE IF NOT EXISTS で準備・終了時に pool.end() します。Docker が無い環境では skipped と記録され、合格には数えられません。
- Next.js のページ・コンポーネントは表示に専念し、計算・検証・整形は同じレイヤーの .ts 純粋関数に切り出してテストします。
- 相対 import は拡張子なし（CommonJS 解決）。時刻・乱数・ID は引数またはコンストラクタで注入し、金額は整数（最小単位）で扱います。
- 入力検証（class-validator / zod）は境界（Controller / API Route）で行い、エラーは HttpException 系または { ok: false, code, message } で明示します。

## Common Rationalizations
| よくある説明 | 確認すべき事実 |
|---|---|
| 実行器が依存なしなので素の .mjs で書き直す | TypeScript プロファイルは依存を実際にインストールして実行します。宣言スタックを勝手に置き換えません。 |
| Service から pg を直接呼べば早い | Repository 層を飛ばすと単体テストに DB が必要になり、Docker の無い環境で全モジュールが検証不能になります。 |
| DB テストは Docker が無ければ通ったことにする | skipped は合格ではありません。DATABASE_URL が無いときは skip し、記録に残します。 |
| 便利なライブラリを package.json に足す | 許可リスト外は install が拒否され、モジュールは失敗します。先にアーキテクチャで合意します。 |
| Nest の DI に任せればテストでも型から注入される | tsx は emitDecoratorMetadata を出さないため、型推論の注入に頼らず new するか @Inject(TOKEN) を使います。 |

## Red Flags
- package.json を出力している、バージョンを指定している、許可リスト外の import がある。
- Service / Controller が pg・SQL 文字列を直接扱っている、SQL を文字列連結で組み立てている。
- DATABASE_URL が無いのに DB テストが skip されず失敗する、または DB テストの結果を合格扱いにしている。
- Next.js コンポーネントの中に業務計算があり、単体テストが無い。
- Date.now() / Math.random() の直接使用、相対 import に .js / .ts 拡張子が付いている。

## Verification
- [ ] 依存は deps に許可リストの名前だけを書き、package.json を出力していません。
- [ ] DB アクセスは Repository インターフェース＋ InMemory 実装＋ Pg 実装に分かれ、SQL はパラメータ化されています。
- [ ] Service / Controller はインターフェースにのみ依存し、単体テストは InMemory リポジトリで new して検証しています。
- [ ] 実 DB テストは DATABASE_URL が無いとき skip され、テーブル準備と pool.end() を行っています。
- [ ] デコレータを使うファイルは reflect-metadata を import し、非クラス注入は @Inject(TOKEN) を使っています。
- [ ] Next.js の業務ロジックは純粋関数に切り出され、具体値・境界・エラーをテストしています。
- [ ] 時刻・乱数・ID は注入され、相対 import は拡張子なしです。
