---
name: dev-java-springboot
description: "Java モジュールは javac / java で実際にコンパイル・実行します。実行側には JDK だけがあり Maven リポジトリはないため、実行コードは JDK 標準ライブラリに限定します。Spring Boot の注釈・依存は設計、デプロイ、移行文書に記載し、競合時は実行条件を優先します。 Java Spring Boot のモジュール、層、トランザクション、DTO、テスト、設定のレビューに使用します。 対象外：Struts2 + JDBC（dev-java-struts）、Node.js（dev-nodejs）、実行モジュールを伴わない文書のみの作業。"
metadata:
  stage: development
  tech: java-springboot
  label: "Java / Spring Boot 開発規約"
---

# Java / Spring Boot 開発規約

## Overview
Java モジュールは javac / java で実際にコンパイル・実行します。実行側には JDK だけがあり Maven リポジトリはないため、実行コードは JDK 標準ライブラリに限定します。Spring Boot の注釈・依存は設計、デプロイ、移行文書に記載し、競合時は実行条件を優先します。

## When to Use
- Java Spring Boot のモジュール、層、トランザクション、DTO、テスト、設定のレビューに使用します。
- 対象外：Struts2 + JDBC（dev-java-struts）、Node.js（dev-nodejs）、実行モジュールを伴わない文書のみの作業。

## Core Process
- ソースは src/main/java/<layer>/、テストは src/test/java/<layer>/ に配置します。テストは main + check(name, ok) と tests/pass/fail の 3 行を出力し、System.exit(fail==0?0:1) で実際の結果を返します。
- controller はプロトコル変換と検証、service は業務とトランザクション、repository は永続化、domain はエンティティと値オブジェクトを担当します。controller から repository を直接呼びません。
- 外部 DTO と永続化 Entity を分離し、明示的な mapper で変換します。
- Spring を使用する移行先ではコンストラクター注入とし、フィールド @Autowired を使いません。Bean は状態を持たず、シングルトンに要求ごとのデータを置きません。
- トランザクションは service の公開メソッドの @Transactional に限定し、controller / repository やサービスをまたぐ呼び出しに拡張しません。
- 入口は @Valid と @NotNull / @Size / @Pattern、業務ルールは service で検証し、ドメイン例外を返します。
- @ControllerAdvice で安定した列挙エラーコードと HTTP 状態に統一し、スタックや SQL を漏らしません。
- 設定は application.yml + @ConfigurationProperties と既定値から取得し、URL・ポート・秘密情報を直書きしません。
- 時刻は java.time / UTC、金額は scale と RoundingMode を指定した BigDecimal、ID は UUID または DB シーケンスを使用します。
- 純粋ロジックのテストは Spring を起動せず、移行先の Web テストは @WebMvcTest / MockMvc、永続化は @DataJpaTest を使い、null でないことだけでなく具体値を検証します。

## Common Rationalizations
| よくある説明 | 確認すべき事実 |
|---|---|
| Spring 注釈を実行コードへ書けば本物になる | 実行側には JDK だけがあります。注釈や依存は設計・移行文書へ記載します。 |
| controller から DB へ直接アクセスする | service の業務・トランザクション境界を維持します。 |
| Entity をそのまま API へ出す | DTO と明示的な mapper で分離します。 |
| フィールド注入や単一インスタンスへの要求状態が簡単 | コンストラクター注入と状態を持たない Bean を使います。 |
| テストでは null でなければよい | 正常・境界・エラーの具体的な結果を検証します。 |

## Red Flags
- 実行コードに Spring / JPA など未提供の import があります。
- 層の逆転、controller の SQL、Entity の直接公開があります。
- フィールド注入、要求状態を保持するシングルトン、不適切なトランザクションがあります。
- 設定の直書き、浮動小数点の金額、UTC 以外の保存時刻があります。

## Verification
- [ ] ソースは src/main/java/<layer>/、テストは src/test/java/<layer>/ に配置します。テストは main + check(name, ok) と tests/pass/fail の 3 行を出力し、System.exit(fail==0?0:1) で実際の結果を返します。
- [ ] controller はプロトコル変換と検証、service は業務とトランザクション、repository は永続化、domain はエンティティと値オブジェクトを担当します。controller から repository を直接呼びません。
- [ ] 外部 DTO と永続化 Entity を分離し、明示的な mapper で変換します。
- [ ] Spring を使用する移行先ではコンストラクター注入とし、フィールド @Autowired を使いません。Bean は状態を持たず、シングルトンに要求ごとのデータを置きません。
- [ ] トランザクションは service の公開メソッドの @Transactional に限定し、controller / repository やサービスをまたぐ呼び出しに拡張しません。
- [ ] 入口は @Valid と @NotNull / @Size / @Pattern、業務ルールは service で検証し、ドメイン例外を返します。
- [ ] @ControllerAdvice で安定した列挙エラーコードと HTTP 状態に統一し、スタックや SQL を漏らしません。
- [ ] 設定は application.yml + @ConfigurationProperties と既定値から取得し、URL・ポート・秘密情報を直書きしません。
- [ ] 時刻は java.time / UTC、金額は scale と RoundingMode を指定した BigDecimal、ID は UUID または DB シーケンスを使用します。
- [ ] 純粋ロジックのテストは Spring を起動せず、移行先の Web テストは @WebMvcTest / MockMvc、永続化は @DataJpaTest を使い、null でないことだけでなく具体値を検証します。
