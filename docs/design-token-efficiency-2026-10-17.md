# 設計書：開発段階のトークン消費を 70% 削減する

> 対象：`agent.mjs` / `harness.mjs` / `exec.mjs` / `governance.mjs`
> 契機：交通局案件（40 モジュール）で **8,082,091 tokens / 20 CNY** を消費した。
> 単価は妥当（2.47 CNY/M ≈ 0.34 USD/M）だが、**同じ成果を 1/3 のトークンで出せる構造**になっていない。
> 本書は「どこを、どう変えれば、いくら減るか」を実装単位で示す。

---

## 1. 計測（事実）

| 指標 | 実測値 | 出所 |
|---|---|---|
| 総トークン | 8,082,091 | DeepSeek ダッシュボード |
| 課金 | 20 CNY | 同上 |
| 記録された呼び出し | 59 回 | `events` の `token usage N` |
| 平均 / 最大 | 53,797 / 76,480 tokens | 同上 |
| 平均内訳（推定） | 入力 ~13K + 出力 ~40K | `moduleCode` のプロンプトと生成ファイル数 |
| モジュール | 40、総 attempts 39 | `modules[].attempts` |
| 失敗の内訳 | 402 残高 16 件 / テスト失敗 多数 / timeout | `modules[].error` |

**構造**：40 モジュール × 平均 1.5 試行 × 54K ≒ 3.2M（記録分）＋ 未記録（402・timeout・上流 4 段階）≒ 8M。

---

## 2. 原因（5 つ、影響の大きい順）

| # | 原因 | 現行実装 | 1 回あたりの無駄 |
|---|---|---|---|
| 1 | **再試行が全文再生成** | `moduleCode()` は失敗時も同じ巨大プロンプトで 13〜14 ファイルを作り直す | 出力 40K → 本来 4K で足りる（**-90%**） |
| 2 | **思考トークンの既定値** | `effort=high` のまま。出力の大半が思考 | 53.8K → 20K（**-63%**、実測済み）※適用済み |
| 3 | **スキル本文を毎回 18K 文字注入** | `skillsBrief()` が `SKILL_PROMPT_MAX=18000` まで本文を連結 | 入力 -30% 可能 |
| 4 | **テスト用 DDL をモデルに書かせる** | テスト内で `CREATE TABLE IF NOT EXISTS` を手書き → 実装の列名・制約とズレて失敗（M12/M13/M17/M19/M23） | 失敗 5 件 = 再試行 15 回 ≈ 0.8M |
| 5 | **キャッシュが効かない** | プロンプト先頭が毎回同じでも、可変要素の順序・内容が安定せず `cached_tokens=0` | 入力 -90%（キャッシュ分） |

---

## 3. 設計原則

1. **再試行は「修正」であって「再制作」ではない** — 既存コードを渡し、差分だけ返させる
2. **決定的に作れるものはモデルに書かせない** — DDL・帳票レイアウト・固定長 IF は生成器
3. **静的部分は不変にする** — キャッシュヒットのため、プロンプト先頭をバイト同一に保つ
4. **失敗はクラス分けする** — インフラ失敗は予算を消費しない、スキーマ不一致は生成器で直す
5. **予算は見える化 + 上限で止める** — 案件単位のトークン予算

---

## 4. 変更設計

### 4.1 再試行を「差分修正モード」に（最大効果）

**現行**
```
runModule → agent.moduleCode(p, mod, feedback)
  → 全プロンプト（~30K 文字）を再送
  → 13〜14 ファイル全体を JSON で返す（~40K tokens）
```

**新設計**
```
runModule（attempt ≧ 2 または 既存ファイルあり）
  → agent.modulePatch(p, mod, { files, test, failure })
    入力：既存ファイル（このモジュール分のみ）+ 落ちたテスト出力末尾 + 「変更点だけ返せ」
    出力：{"patches":[{"path":...,"content":...}], "reason":"..."}
  → harness 側で path 単位にマージ（未変更ファイルは保持）
  → テスト再実行
```

**API 変更**
```js
// agent.mjs
export async function modulePatch(project, mod, { files, test, failure }) { ... }
// 出力スキーマ
{ patches: [{ path, content }], test: { path, content } | null, questions: [] }
```

**harness.mjs**
```js
const initial = !(mod.files || []).length;
const code = initial
  ? await agent.moduleCode(p, mod, lastFeedback(mod))
  : await agent.modulePatch(p, mod, {
      files: mod.files.map(f => ({ path: f.path, content: readFile(f.path) })),
      test: { path: mod.test_path, content: readFile(mod.test_path) },
      failure: lastFeedback(mod),
    });
```

**入力削減**：要件抜粋（6K）+ deps（8K）+ スキル（18K）を送らない。
→ 入力 30K 文字 → 8K 文字、出力 40K tokens → 4〜8K tokens。

**期待削減：再試行 1 回 54K → 12K（-78%）**

---

### 4.2 テスト用スキーマを生成器に移す（失敗そのものを減らす）

M12/M13/M17/M19/M23 の失敗はすべて「テストが手書きした DDL と実装 SQL の不一致」。

**新設計**
1. `tools/generate_ddl.mjs`（実装済み）で `schema/<TABLE>.json` → `migrations/*.sql` を生成
2. テスト側は生成済み DDL を読むだけ：
```ts
import { applySchema } from './_schema';
await applySchema(['SIF_BHNDAI', 'SHF_SEBSIJ']);   // migrations/*.sql を実行
```
3. プロンプトに明記：「CREATE TABLE を書くな。`applySchema([...])` を使え」

**効果**：スキーマ不一致の失敗クラスが消える（今回 5 モジュール = 15 試行 ≈ 0.8M tokens）。

---

### 4.3 スキルを 2 段階注入に

**現行**：`skillsBrief()` が本文を 18,000 文字まで連結。

**新設計**
| 区分 | 内容 | 上限 |
|---|---|---|
| 索引（常時） | 名前 + 1 行説明 + 適用段階 | 1,500 文字 |
| 主軸 1 本（当該段階） | 本文 | 4,000 文字 |
| チェックリスト | 見出し + 検証項目のみ | 2,000 文字 |
| 案件専用（project role） | 本文 | 2,000 文字 |

```js
// agent.mjs
export function skillsBrief(project, stageId = '', { max = 6500 } = {})
```
**期待削減：入力 12K → 5K tokens（-58%）**

---

### 4.4 プロンプトキャッシュを効かせる

DeepSeek は同一プレフィックスの入力を `cached_tokens` として 1/10 価格で課金する。

**要件**
1. プロンプトの**先頭**に「不変ブロック」を置く：
   ```
   [system] 役割 + 出力規則 + 言語規則        （固定）
   [user]   案件仕様 + スキル本文（固定）      ← 案件・段階ごとに固定
   [user]   モジュール固有（可変）             ← ここから下だけ変わる
   ```
2. スキル・仕様の文字列を**毎回同一に**（ソート・整形を固定）
3. `chat()` に `cacheKey` を持たせ、変化時にのみ再生成

**期待削減：固定部分（~9K tokens）の入力費 -90%**

---

### 4.5 失敗クラス分けと予算

```js
export function classifyFailure(err) {
  if (/Insufficient Balance|\b402\b/.test(err)) return 'billing';   // 予算を消費しない
  if (/timeout|fetch failed|429|50[234]/.test(err)) return 'infra'; // 同上（既存）
  if (/varchar|22001|checkInsertTargets|infer_arbiter_indexes/.test(err)) return 'schema'; // 生成器で直す
  return 'test';                                                     // 修正モードで再試行
}
```

| クラス | 再試行 | 予算消費 | 対応 |
|---|---|---|---|
| billing | 停止 | 0 | 残高補充を待つ |
| infra | 2 回 | 0 | 再送 |
| schema | 1 回 | 0 | `generate_ddl` + `applySchema` を当てる |
| test | 3 回（2 回目以降 patch） | **消費** | 差分修正 |

---

### 4.6 予算ガードと可視化

```js
// settings / env
AI_PLATFORM_TOKEN_BUDGET=2000000      // 案件あたり上限
AI_PLATFORM_COST_PER_MTOK=2.5         // 表示用（CNY/M）
```

- `pushEvent` に `usage: {in, out, cached, cost}` を追加
- Traceability に「案件の累計トークン / 概算コスト / 1 モジュール平均」
- 上限超過で `runModule` を停止し、イベントに `budget exhausted` を残す

---

## 5. 期待効果（試算）

| 対策 | 対象 | 削減率 | 8M 換算 |
|---|---|---|---|
| 4.1 差分修正モード | 再試行すべて | -78% | -2.5M |
| 4.2 生成器 DDL | スキーマ失敗 5 件 | 失敗消滅 | -0.8M |
| 4.3 スキル 2 段階 | 全呼び出しの入力 | -58%（入力分） | -1.2M |
| 4.4 キャッシュ | 入力 9K/回 | -90%（入力分） | -1.0M |
| 4.5/4.6 予算管理 | 無駄な再試行 | — | -0.5M |
| （適用済み）reasoning_effort=none | 出力 | -63% | -2.0M |

**合計：8.0M → 約 2.0〜2.5M（-70%）／20 CNY → 約 6 CNY**

---

## 6. 実装計画

| Phase | 内容 | 工数 | 検証 |
|---|---|---|---|
| P0（完了） | `reasoning_effort` 対応（`AI_PLATFORM_REASONING_EFFORT`） | 0.5h | 実測 53.8K→20K |
| P1 | 差分修正モード `modulePatch()` + harness マージ | 3〜4h | 同一モジュールで再試行トークン比較 |
| P2 | テストスキーマ生成器連携（`applySchema`） | 2h | M12/M13/M17/M19/M23 を再実行して失敗ゼロ |
| P3 | スキル 2 段階注入 | 2h | 入力トークン計測 |
| P4 | キャッシュ最適化（プレフィックス固定） | 1.5h | `cached_tokens` > 0 を確認 |
| P5 | 失敗クラス分け + 予算ガード + 可視化 | 2.5h | 上限超過で停止、UI 表示 |

**合計 11〜12h**（P1 が最大効果・最優先）

---

## 7. 検証方法

1. **同一モジュールの A/B**：M23 を現行方式と差分方式で再実行し、`usage.total_tokens` を比較
2. **キャッシュ確認**：`chat()` のレスポンス `usage.prompt_tokens_details.cached_tokens > 0`
3. **失敗クラス**：402 / timeout / schema / test を意図的に起こして分岐を確認
4. **回帰**：`AI_PLATFORM_SPEED=0 node --test test/` と `bash tools/run_all.sh`
5. **通し**：交通局案件を再ビルドし、総トークンが 2.5M 以下・全 40 モジュール承認を確認

---

## 8. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| 差分モードでモデルが壊れた全ファイルを返す | 品質低下 | 返却 patch を path 単位で検証（未知 path は捨てる、サイズ上限） |
| キャッシュ最適化で可変情報が古くなる | 誤実装 | `cacheKey` に spec ハッシュを含め、変更時に無効化 |
| スキル削減で品質低下 | レビューで検出 | 段階別 A/B（スキルあり/なし）で承認率を比較 |
| 生成器 DDL と実装 SQL のズレ | 別の失敗 | 実装側も同じ schema 定義から型を生成（将来） |
| 予算上限で途中停止 | 案件遅延 | 上限は警告 → 承認者のみ続行可 |

---

## 9. 補足：今回の案件で判明した副次的事実

- `src/core` に 20 モジュール集中 → 再検証の振動（修正済み：`reverifyApprovedModules` をファイル単位に限定）
- 402 残高切れが 3 回の再試行予算を消費 → `billing` クラスとして予算外にすべき
- 承認済みモジュールでも同層ファイル上書きで打ち戻る → 層あたりのモジュール数を WBS で分散させる改善も併用したい
