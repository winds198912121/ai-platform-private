---
name: dev-python
description: "Python モジュールは python3 と標準ライブラリ unittest で実行します。src/<layer>/<snake_case>.py と test/<layer>/<name>.test.py を対応させ、テスト末尾で unittest.main() を呼びます。実行側はサードパーティパッケージを導入しないため、この実行条件を優先します。 Python モジュール、パッケージ構造、ドメインモデル、例外、ログ、モジュールテストの作成・修正に使用します。 対象外：他言語のソース変更、実行モジュールを作らない設計・デプロイ文書のみの作業。"
metadata:
  stage: development
  tech: python
  label: "Python 開発規約"
---

# Python 開発規約

## Overview
Python モジュールは python3 と標準ライブラリ unittest で実行します。src/<layer>/<snake_case>.py と test/<layer>/<name>.test.py を対応させ、テスト末尾で unittest.main() を呼びます。実行側はサードパーティパッケージを導入しないため、この実行条件を優先します。

## When to Use
- Python モジュール、パッケージ構造、ドメインモデル、例外、ログ、モジュールテストの作成・修正に使用します。
- 対象外：他言語のソース変更、実行モジュールを作らない設計・デプロイ文書のみの作業。

## Core Process
- domain / service / adapter を責務で分け、業務ルールをフレームワーク非依存の純粋関数・クラスにします。CLI / Web の入口は引数解析と呼び出しに限定します。
- 公開関数の引数と戻り値に型を付け、ドメインデータは dataclass などで明示します。pydantic など外部ライブラリの採用は実行モジュールではなく設計・移行文書に限定します。
- def f(x=[]) のような可変既定引数は禁止し、None を受けて内部で作成します。
- 裸の except や except Exception: pass は禁止します。DomainError から派生する具体的な例外を作り、対象エンティティとフィールドを説明します。
- 金額は decimal.Decimal で精度と ROUND_HALF_UP を明示します。時刻はタイムゾーン付き datetime とし、UTC で保存して表示時に変換します。
- パスは pathlib で構成し、encoding="utf-8" を明示します。
- 依存が許可される本来の構成では pyproject.toml / requirements.txt のバージョンと仮想環境を固定し、新規依存の理由を記載します。プラットフォーム内は標準ライブラリだけを使用します。
- 実行テストは unittest とし、ソースディレクトリを sys.path に追加して import します。正常・境界・エラーを具体値で検証し、実行順や実ネットワークに依存しません。pytest / parametrize は設計・移行先のテスト方針として扱います。
- logging の構造化フィールドを使用し、print をログ代わりにしません。パスワード・トークン・個人データを記録しません。

## Common Rationalizations
| よくある説明 | 確認すべき事実 |
|---|---|
| FastAPI / pytest が一般的なので直接 import する | プラットフォーム内は標準ライブラリのみで、実行条件を優先します。 |
| 可変既定引数は便利 | 呼び出し間で状態が共有されます。None と内部生成を使います。 |
| すべての例外を捕捉して無視する | 具体的な例外と対象・フィールドの情報が必要です。 |
| 金額は float でよい | Decimal の精度と丸め方を明示します。 |
| 実ネットワークを使えば十分 | テストの再現性と独立性を確保します。 |

## Red Flags
- 外部パッケージを実行モジュールへ import しています。
- 可変既定引数、裸の except、例外の握り潰しがあります。
- 金額を float、時刻をタイムゾーンなしで扱っています。
- パスの文字列連結、既定文字コード、print ログ、秘密情報の記録があります。

## Verification
- [ ] domain / service / adapter を責務で分け、業務ルールをフレームワーク非依存の純粋関数・クラスにします。CLI / Web の入口は引数解析と呼び出しに限定します。
- [ ] 公開関数の引数と戻り値に型を付け、ドメインデータは dataclass などで明示します。pydantic など外部ライブラリの採用は実行モジュールではなく設計・移行文書に限定します。
- [ ] def f(x=[]) のような可変既定引数は禁止し、None を受けて内部で作成します。
- [ ] 裸の except や except Exception: pass は禁止します。DomainError から派生する具体的な例外を作り、対象エンティティとフィールドを説明します。
- [ ] 金額は decimal.Decimal で精度と ROUND_HALF_UP を明示します。時刻はタイムゾーン付き datetime とし、UTC で保存して表示時に変換します。
- [ ] パスは pathlib で構成し、encoding="utf-8" を明示します。
- [ ] 依存が許可される本来の構成では pyproject.toml / requirements.txt のバージョンと仮想環境を固定し、新規依存の理由を記載します。プラットフォーム内は標準ライブラリだけを使用します。
- [ ] 実行テストは unittest とし、ソースディレクトリを sys.path に追加して import します。正常・境界・エラーを具体値で検証し、実行順や実ネットワークに依存しません。pytest / parametrize は設計・移行先のテスト方針として扱います。
- [ ] logging の構造化フィールドを使用し、print をログ代わりにしません。パスワード・トークン・個人データを記録しません。
