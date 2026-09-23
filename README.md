# Toki

Tokiは、ストップウォッチ・タイマーで測った時間に行動内容を付け、アプリ内カレンダーで振り返る本人用の時間管理アプリです。`rizakura-hontai`からは通常のリンクで移動し、Tokiの実行時コード・Worker・D1は独立させます。

## 現在の状態

Phase 42までに独立したAccess JWT検証、ローカルD1の計測schema/API、ストップウォッチ・タイマーの計測画面、アプリ内の日・週カレンダーと記録編集、Toki専用PWAのmanifest・アイコン、基盤への戻りリンクを実装し、単体・ローカルブラウザE2Eで検証しました。Phase 43ではToki専用D1・Worker・本人限定Accessを設定し、[本番URL](https://toki.sx7k2p9q.workers.dev/)を公開しました。PCで計測・保存・編集・タイマーを確認済みで、iPhone PWAの実機確認は進行中です。基盤との通信は行わず、ページ遷移だけです。スマートフォンのホーム画面起動用で、オフライン保存やService Workerは設けません。画面・manifest・アイコンもWorkerの認証を通った場合だけ配信します。`/__local/db`はローカル起動時にだけ明示的な変数で有効化する接続検査で、業務データは返しません。

製品仕様とフェーズ計画は基盤repositoryの`docs/toki-design.md`・`docs/toki-roadmap.md`を正とします。このrepositoryへ基盤/Tech Inbox/Daymarkのsourceをコピーしたり、実データやCloudflare資格情報を追加したりしません。

## ローカル検証

Node.js `24.19.0`とpnpm `11.22.0`を使用します。依存・キャッシュ・一時ファイルはこのrepository内に保持します。

```sh
pnpm install --frozen-lockfile
PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/ms-playwright" pnpm exec playwright install chromium
pnpm check
```

`pnpm check`はformat、lint、生成型、TypeScript、coverage付きtest、local D1 migrationと`time_sessions`検査、Worker dry-run build、ローカルChromium E2E、依存監査を実行します。E2Eは毎回専用の一時D1を使い、認証バイパスあり・なしの2つのloopback Workerを検証します。Cloudflareのremote DBやWorkerは作成・変更しません。

必要な場合に限り、`pnpm dev`でローカルWorkerを起動できます。`/__local/db`と画面/APIの認証バイパスは明示的なローカル起動引数かつloopback HTTPに限定します。`.dev.vars`や`.env`は追跡しません。本番では画面/APIとも本人限定Accessに加えてWorkerでJWTを検証します。

## 本番設定の事前準備（Cloudflareへの変更なし）

追跡している`wrangler.jsonc`はローカル専用で、そのまま本番へdeployしません。Phase 43で所有者が専用D1の名前`toki`とハイフン付きの正式なdatabase UUID（8-4-4-4-12桁）を確認した後、IDを`TOKI_D1_DATABASE_ID`環境変数へ設定し、明示的な公開段階を選んで次を実行します。Account IDのような32桁の値は受け付けません。IDや認証値をCLI引数・Git・ログへ書かないでください。

以下は準備用のローカル操作で、Cloudflareへの作成・migration・deployを実行しません。生成設定を使ったremote操作には、実際のアカウントのFreeプランと使用量、専用D1の存在とID、所有者の本番操作承認が必要です。`stage`による非公開Workerの配置はAccess作成より先に行い、Workerの不変IDを確認します。`live`による公開だけは、本人限定AccessとWorker secretの検証が完了するまで行いません。

```sh
pnpm production:config:stage
pnpm exec wrangler deploy --dry-run --config .tmp/toki-production-stage.jsonc --outdir .tmp/toki-production-stage-build
```

`stage`は`workers_dev:false`で非公開のままWorker・D1 binding・静的assetを検査します。Toki専用Access applicationの本人限定policyとWorker secretの設定を読み取り専用で確認してから、`pnpm production:config:live`で公開用設定を別途生成・dry-runします。実際の本人ログインと未認証拒否は`workers.dev`を有効にした後で確認します。liveは`workers_dev:true`なので、実際のdeployは対象・費用・認証・D1 migrationを確認したうえで所有者が明示承認した範囲に限ります。Phase 43ではToki専用リソースについて承認済みですが、既存の基盤Worker更新は含みません。いずれも生成設定は`.tmp/`内のGit無視対象で、Worker名/D1名を`toki`、D1 bindingを`DB`、preview URLを無効、すべてのassetをWorkerの認証経由に固定します。別のroute、custom domain、ローカル認証バイパス、認証値は含みません。構成ファイルの相対pathは`.tmp/`基準です。

初回リソース作成前だけ`node scripts/verify-cloudflare-preflight.mjs`を読み取り専用で使用します。作成後は`toki`と同名のリソースが存在するため、この事前検査が停止するのが正常です。非公開`stage` Worker配置後、`node scripts/configure-access.mjs`は既定で読み取り専用、`--apply`は追加の`TOKI_ACCESS_SETUP_CONFIRM=toki`が必要です。Zone routeのGETが権限不足のHTTP 403になったときだけ、所有者がToki Worker画面で経路なしを確認した場合に限り、`TOKI_ROUTES_DASHBOARD_VERIFIED=toki`を指定できます。他のAPI失敗や実際のrouteは迂回しません。このAccess設定スクリプトは**非公開`stage`状態での初回設定用**で、公開後の再実行には使いません。
