# Toki

Tokiは、ストップウォッチ・タイマーで測った時間に行動内容を付け、アプリ内カレンダーで振り返る本人用の時間管理アプリです。`rizakura-hontai`からは通常のリンクで移動し、Tokiの実行時コード・Worker・D1は独立させます。

## 現在の状態

Phase 42までに独立したAccess JWT検証、ローカルD1の計測schema/API、ストップウォッチ・タイマーの計測画面、アプリ内の日・週カレンダーと記録編集、Toki専用PWAのmanifest・アイコン、基盤への戻りリンクを実装し、単体・ローカルブラウザE2Eで検証しました。Phase 43ではToki専用D1・Worker・本人限定Accessを設定し、[本番URL](https://toki.sx7k2p9q.workers.dev/)を公開しました。所有者はPCで計測・保存・編集・タイマーを、iPhoneのホーム画面から起動するPWAで計測・保存・編集・再起動後の記録保持を確認しました。基盤入口とTokiの往復、Tech Inbox・Daymarkの表示も確認済みです。基盤との通信は行わず、ページ遷移だけです。スマートフォンのホーム画面起動用で、オフライン保存やService Workerは設けません。画面・manifest・アイコンもWorkerの認証を通った場合だけ配信します。`/__local/db`はローカル起動時にだけ明示的な変数で有効化する接続検査で、業務データは返しません。

Phase 44では、カレンダーでの計測なしの記録追加と、編集画面で確認後に行う保存済み記録の完全削除を実装しました。過去・未来の時間帯と既存記録との重複を許可します。2026-09-23のPhase 45で、所有者の承認後に専用D1のバックアップ・migrationとToki Workerの本番deployを実施しました。既存データの全項目一致、本人限定Accessの維持、未認証拒否、認証済みブラウザでの手動登録・編集・再読み込み・削除キャンセル・完全削除を確認済みです。検証用記録は削除し、既存記録と未完了計測は変更していません。追加機能についての所有者自身のPC/iPhone実機確認は未実施です。

Phase 47では、短時間の記録でも内容が1行見えるように、カレンダーの時間軸を1時間120px、記録の表示枠を最低44pxに変更しました。内容を時刻より先に表示し、隣接する短い記録は表示上の重なりを判定して横に分けます。長い内容は1行で省略し、全文・正確な時刻は記録を開いて確認できます。PCの日/週・スマートフォンの日表示が対象で、保存時刻・API・DB・認証は変更しません。2026-09-26に所有者の承認後、検証済みcommit `5ee7050`をToki Workerへ本番反映しました。認証済みブラウザの日/週表示と短い記録名、編集画面への遷移・保存せずキャンセル、未認証拒否を確認済みです。DB migration・記録の更新・認証/料金設定の変更は行っていません。

Phase 48では、手動の新規登録フォームを分単位（秒は00）にし、内容を任意にしました。手動・ストップウォッチ・タイマーの保存と記録編集で空欄/空白だけを受け付け、保存時に「無題」で補完するため、カレンダーと記録一覧にも「無題」が表示されます。既存記録の編集は引き続き秒単位で、内容だけの編集では元の秒・ミリ秒を保持します。2026-09-27に所有者の承認後、検証済みcommit `bab03ef`をToki Workerへ本番反映しました。認証済みブラウザで分単位・内容任意の手動登録フォームと計測画面を確認し、未認証10経路のAccess保護も検証済みです。DB schema/migration・記録の更新・進行中の計測・認証/料金設定は変更していません。空欄保存と再読み込み後の保持はローカルE2Eで検証し、本番では確認用の記録を保存していません。

2026-10-04に、基盤・Tech Inbox・Daymarkと技術スタックを揃える方針とPhase 49〜56の移行手順を記録しました。Phase 50では移行前の回帰テストと合成データを追加しました。Phase 51では既存のHTML/DOM画面をViteでbuildする構成とReact/Tailwindの開発基盤を導入しました。画面のReact置換はPhase 54、APIのHono化はPhase 52、DBのDrizzle化はPhase 53で行います。独立repository/Worker/D1、機能・URL・記録・PWAを維持し、本番は変更していません。

製品仕様とフェーズ計画は基盤repositoryの`docs/toki-design.md`・`docs/toki-roadmap.md`を正とします。このrepositoryへ基盤/Tech Inbox/Daymarkのsourceをコピーしたり、実データやCloudflare資格情報を追加したりしません。

## ローカル検証

Node.js `24.19.0`とpnpm `11.22.0`を使用します。依存・キャッシュ・一時ファイルはこのrepository内に保持します。

```sh
pnpm install --frozen-lockfile
PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/ms-playwright" pnpm exec playwright install chromium
pnpm check
```

`pnpm check`はformat、lint、生成型、browser/Worker/test/Node別のTypeScript、coverage付きtest、local D1 migrationと`time_sessions`検査、Vite build・成果物検査・Worker dry-run、ローカルChromium E2E、依存監査を実行します。E2Eはbuild済みWorkerとassetsを使い、毎回専用の一時D1、認証バイパスあり・なしの2つのloopback Workerを検証します。Cloudflareのremote DBやWorkerは作成・変更しません。GitHub Actionsも同じgateを使い、deployは行いません。

必要な場合に限り、`pnpm dev`でbuild後のローカルWorkerを起動できます。Phase 51では本番と同じCSP・認証経路を検証するため、Vite HMRではなくbuild済み成果物を配信します。source編集後は停止・再実行してください。migration・検査・起動のローカルDB保存先をrepository内の`.wrangler/state`へ固定し、再buildで消される`dist`の中には保存しません。`/__local/db`と画面/APIの認証バイパスは明示的なローカル起動引数かつloopback HTTPに限定します。`.dev.vars`や`.env`は追跡しません。本番では画面/APIとも本人限定Accessに加えてWorkerでJWTを検証します。

### Phase 51の開発基盤

rootの`index.html`・`calendar.html`から、`src/client/`のTypeScript entrypointと既存JavaScript/CSSを読み込みます。ViteのReact/Tailwind/Cloudflare pluginsが`dist/client/`と`dist/toki/`を生成します。`public/`には変更しないmanifestとアイコンだけを残します。React/Router/Testing Library/jsdomの接続も単体テストで検証しますが、Reactを既存DOMへ重ねてmountすることはありません。

見た目を保つため、Tailwindの[Preflight](https://tailwindcss.com/docs/preflight)と既存HTMLの自動class走査はまだ有効にしません。Reactへの画面置換時に必要なutilityを明示します。ビルド済みJS/CSSは8文字hash付きpathに限定し、すべてWorkerの認証を通します。未知URL・欠落asset・source・source mapをHTMLへfallbackしません。PWA identityと旧HTML URLは維持し、Service Workerは追加しません。

依存は基盤の確認済み完全版へ揃え、jsdom配下Undiciは修正版`8.10.2`に固定しました。7日gate・strict peer・integrity・install script制限を保ち、Drizzle Kitはこの段階では導入しません。詳細は基盤の`docs/dependency-baseline.md`を参照してください。

Phase 51の全品質gateは16 files/332 tests、PC/320pxブラウザ16件、audit指摘0件で成功しました。成果物の配信制限と、ローカルDBの保存先を再buildで消えない場所へ固定するテストも含みます。本番反映・iPhone実機の再確認は行っていません。

### Phase 50の移行比較テスト

`tests/fixtures/toki-baseline.ts`は架空の記録だけを定義します。本番exportを置き換えとして使わないでください。`src/api/compatibility.test.ts`は実SQLiteを通したHTTP応答全体、ミリ秒・null・版数・再試行・削除後の復活防止・入力境界を比較します。`src/data/migration-baseline.test.ts`は既存migrationによる全列保持、未完了4状態、列・部分index・削除trigger・CHECK/unique制約を検証します。SQLiteアダプターはD1を完全再現するものではないため、WranglerのローカルD1とE2Eも引き続き必須です。

`tests/e2e/migration-baseline.spec.ts`はPC/320pxで既存URL・戻る/進む・再読み込みと計測状態の保持、通常/集中表示で毎秒APIを呼ばないこと、HTMLが参照する実際のassetの保護、未知pathの404を固定します。保存・編集・削除・空欄の無題・時刻精度・短い記録の表示・PWA identityは既存テストと併せて検証します。後続移行ではテストを新実装に接続し、期待する外部動作を変更して通すことはしません。

Phase 50の全品質検証は単体/統合246件・ブラウザ16件が成功し、依存修正後のauditは指摘0件でした。これはローカル検証であり、本番反映やiPhone実機の再確認は行っていません。

依存再監査で開発用Miniflare配下のUndiciにhighの指摘が見つかったため、Phase 50では親versionを限定して`undici 7.29.0 → 7.29.1`だけを更新しました。その時点では直接依存を変更していません。[Undici公式advisory](https://github.com/nodejs/undici/security/advisories/GHSA-rfgv-xxqx-mfg5)を参照してください。移行先の固定版と導入結果は、基盤repositoryの`docs/dependency-baseline.md`・`docs/toki-roadmap.md`に記録します。

## 本番設定の事前準備（Cloudflareへの変更なし）

追跡している`wrangler.jsonc`はローカル専用で、そのまま本番へdeployしません。Phase 43で所有者が専用D1の名前`toki`とハイフン付きの正式なdatabase UUID（8-4-4-4-12桁）を確認した後、IDを`TOKI_D1_DATABASE_ID`環境変数へ設定し、明示的な公開段階を選んで次を実行します。Account IDのような32桁の値は受け付けません。IDや認証値をCLI引数・Git・ログへ書かないでください。

以下は準備用のローカル操作で、Cloudflareへの作成・migration・deployを実行しません。Phase 51以降の設定生成はbuild済み`dist/toki/index.js`と`dist/client`の存在・安全な設定・参照assetを検査し、sourceや`public`へのfallbackを拒否します。生成設定は`no_bundle:true`で検証済み成果物を参照します。remote操作にはFreeプランと使用量、専用D1の存在とID、所有者の本番操作承認が必要です。初回公開時の`stage`はAccess作成より先に行い、Workerの不変IDを確認します。`live`による公開だけは、本人限定AccessとWorker secretの検証が完了するまで行いません。

```sh
pnpm build
pnpm production:config:stage
pnpm exec wrangler deploy --dry-run --config .tmp/toki-production-stage.jsonc --outdir .tmp/toki-production-stage-build
```

`stage`は`workers_dev:false`で非公開のままWorker・D1 binding・静的assetを検査します。Toki専用Access applicationの本人限定policyとWorker secretの設定を読み取り専用で確認してから、`pnpm production:config:live`で公開用設定を別途生成・dry-runします。実際の本人ログインと未認証拒否は`workers.dev`を有効にした後で確認します。liveは`workers_dev:true`なので、実際のdeployは対象・費用・認証・D1 migrationを確認したうえで所有者が明示承認した範囲に限ります。Phase 43の最初の承認はToki専用リソースが対象で、既存の基盤Worker更新は後に別途承認を得て実施しました。いずれも生成設定は`.tmp/`内のGit無視対象で、Worker名/D1名を`toki`、D1 bindingを`DB`、preview URLを無効、すべてのassetをWorkerの認証経由に固定します。別のroute、custom domain、ローカル認証バイパス、認証値は含みません。構成ファイルの相対pathは`.tmp/`基準です。

初回リソース作成前だけ`node scripts/verify-cloudflare-preflight.mjs`を読み取り専用で使用します。作成後は`toki`と同名のリソースが存在するため、この事前検査が停止するのが正常です。非公開`stage` Worker配置後、`node scripts/configure-access.mjs`は既定で読み取り専用、`--apply`は追加の`TOKI_ACCESS_SETUP_CONFIRM=toki`が必要です。Zone routeのGETが権限不足のHTTP 403になったときだけ、所有者がToki Worker画面で経路なしを確認した場合に限り、`TOKI_ROUTES_DASHBOARD_VERIFIED=toki`を指定できます。他のAPI失敗や実際のrouteは迂回しません。このAccess設定スクリプトは**非公開`stage`状態での初回設定用**で、公開後の再実行には使いません。
