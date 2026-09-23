# Toki

Tokiは、ストップウォッチ・タイマーで測った時間に行動内容を付け、アプリ内カレンダーで振り返る本人用の時間管理アプリです。`rizakura-hontai`からは通常のリンクで移動し、Tokiの実行時コード・Worker・D1は独立させます。

## 現在の状態

Phase 36では独立した開発環境と、認証前に公開機能を返さないWorker、ローカルD1の接続検査だけを用意します。計測・カレンダーのテーブル/API、画面、PWA、Cloudflare Access、本番Worker/DBはまだありません。Workerの通常応答は`503`です。`/__local/db`はローカル起動時にだけ明示的な変数で有効化する接続検査で、業務データは返しません。

製品仕様とフェーズ計画は基盤repositoryの`docs/toki-design.md`・`docs/toki-roadmap.md`を正とします。このrepositoryへ基盤/Tech Inbox/Daymarkのsourceをコピーしたり、実データやCloudflare資格情報を追加したりしません。

## ローカル検証

Node.js `24.19.0`とpnpm `11.22.0`を使用します。依存・キャッシュ・一時ファイルはこのrepository内に保持します。

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check`はformat、lint、生成型、TypeScript、coverage付きtest、local D1の`SELECT 1`、Worker dry-run build、依存監査を実行します。Cloudflareのremote DBやWorkerは作成・変更しません。

必要な場合に限り、`pnpm dev`でローカルWorkerを起動できます。`/__local/db`はローカル開発用で、通常のrouteは安全側に閉じています。`.dev.vars`や`.env`は追跡しません。Phase 37以降に認証と業務APIを加える際も、本人限定Accessに加えてWorkerでJWTを検証します。
