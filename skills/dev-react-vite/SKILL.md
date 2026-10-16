---
name: dev-react-vite
description: "プラットフォーム内では Node 標準ライブラリと node --test を使い、JSX・React・Vite を直接実行しません。h(type, props, ...children) が返す {type, props, children} と純粋関数でビュー・状態を表現し、実際の JSX・Vite 構成と公開は設計・デプロイ文書で扱います。 React + Vite サイトのデータ、reducer、selector、経路、要素オブジェクト、エスケープ、SEO・アクセシビリティの開発・レビュー。 対象外：ビルド不要 HTML（dev-static-site）、プラットフォーム内で JSX や vite build を実行する要件。"
metadata:
  stage: development
  tech: react-vite
  label: "React / Vite 開発規約"
---

# React / Vite 開発規約

## Overview
プラットフォーム内では Node 標準ライブラリと node --test を使い、JSX・React・Vite を直接実行しません。h(type, props, ...children) が返す {type, props, children} と純粋関数でビュー・状態を表現し、実際の JSX・Vite 構成と公開は設計・デプロイ文書で扱います。

## When to Use
- React + Vite サイトのデータ、reducer、selector、経路、要素オブジェクト、エスケープ、SEO・アクセシビリティの開発・レビュー。
- 対象外：ビルド不要 HTML（dev-static-site）、プラットフォーム内で JSX や vite build を実行する要件。

## Core Process
- JSX を書かず、react / react-dom / vite を import しません。要素オブジェクトの型・本文・属性・子の数を直接検証します。
- データ、reducer、selector、検証、経路照合、ページ分割・絞り込み・並べ替えを純粋関数へ分離します。ビューは組み立てとイベント結合を担当し、ハンドラーは新しい状態またはアクションを返します。
- 状態は (state, action) => nextState の reducer、アクションは定数とします。時刻・乱数・fetchJson を注入し、モジュール単位の可変シングルトンを使いません。
- 移行先の React コンポーネントは関数、props は読み取り専用とし、導出可能な値を state に重複保存しません。key は安定した業務 ID とし、添字は使いません。0 が表示される count && の条件式を避け、三項式か早期 return を使用します。
- 静的公開では hash ルーティング、または dist/404.html へのフォールバックを設定します。routes() の path・ページ・タイトル・必要データを唯一の経路表とし、リンクを生成・検証します。
- dangerouslySetInnerHTML、利用者が制御する href / style、javascript: は禁止または許可リスト化します。内容・API のテキストは純粋関数層で esc() を通します。
- html lang、title、description、canonical、header/nav/main/footer、alt、見出し階層、label を要素オブジェクト層で具体的に検証します。
- 公開用の vite build は配置サブパスに合わせて base を設定します。public/ はそのままコピーする資源、出力は dist/ とします。VITE_ 変数は公開成果物へ含まれるため秘密情報を入れません。オブジェクトストレージ / CDN に配備し、前版 dist/ を残して戻せるようにします。
- CSS Modules または通常 CSS を使い、テーマ色・余白は CSS 変数へまとめます。大量の inline style、外部フォント、外部アイコンライブラリを避け、inline SVG とシステムフォントで初期表示のずれを抑えます。
- プラットフォームで検証した範囲はデータ・reducer・経路・要素です。フォーカス、スクロール、アニメーション、実 API、Lighthouse は結合テスト一覧にプラットフォーム内未実行と明記します。

## Common Rationalizations
| よくある説明 | 確認すべき事実 |
|---|---|
| JSX は一般的なので直接生成する | 実行側は JSX を扱えません。要素オブジェクトを生成し、移行先の JSX は文書へ分けます。 |
| state に導出値も保存する | 重複状態を避け、reducer と純粋な導出関数を使います。 |
| React がすべて XSS を防ぐ | 危険な HTML・URL・style の入口は別途禁止・制限します。 |
| VITE_ に秘密を入れてよい | ビルドされたフロントエンドは公開物です。 |
| 要素のテストでブラウザーも検証できる | ブラウザー固有の挙動は別に実行・記録します。 |

## Red Flags
- 実行モジュールに JSX、React / Vite import、外部資源があります。
- 可変単一状態、直接の時刻・乱数、導出値の重複、添字 key があります。
- 危険な HTML・URL、未設定 base、公開変数の秘密情報があります。
- 未実行のブラウザー挙動や性能指標を検証済みとしています。

## Verification
- [ ] JSX を書かず、react / react-dom / vite を import しません。要素オブジェクトの型・本文・属性・子の数を直接検証します。
- [ ] データ、reducer、selector、検証、経路照合、ページ分割・絞り込み・並べ替えを純粋関数へ分離します。ビューは組み立てとイベント結合を担当し、ハンドラーは新しい状態またはアクションを返します。
- [ ] 状態は (state, action) => nextState の reducer、アクションは定数とします。時刻・乱数・fetchJson を注入し、モジュール単位の可変シングルトンを使いません。
- [ ] 移行先の React コンポーネントは関数、props は読み取り専用とし、導出可能な値を state に重複保存しません。key は安定した業務 ID とし、添字は使いません。0 が表示される count && の条件式を避け、三項式か早期 return を使用します。
- [ ] 静的公開では hash ルーティング、または dist/404.html へのフォールバックを設定します。routes() の path・ページ・タイトル・必要データを唯一の経路表とし、リンクを生成・検証します。
- [ ] dangerouslySetInnerHTML、利用者が制御する href / style、javascript: は禁止または許可リスト化します。内容・API のテキストは純粋関数層で esc() を通します。
- [ ] html lang、title、description、canonical、header/nav/main/footer、alt、見出し階層、label を要素オブジェクト層で具体的に検証します。
- [ ] 公開用の vite build は配置サブパスに合わせて base を設定します。public/ はそのままコピーする資源、出力は dist/ とします。VITE_ 変数は公開成果物へ含まれるため秘密情報を入れません。オブジェクトストレージ / CDN に配備し、前版 dist/ を残して戻せるようにします。
- [ ] CSS Modules または通常 CSS を使い、テーマ色・余白は CSS 変数へまとめます。大量の inline style、外部フォント、外部アイコンライブラリを避け、inline SVG とシステムフォントで初期表示のずれを抑えます。
- [ ] プラットフォームで検証した範囲はデータ・reducer・経路・要素です。フォーカス、スクロール、アニメーション、実 API、Lighthouse は結合テスト一覧にプラットフォーム内未実行と明記します。
