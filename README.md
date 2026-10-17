# Toki

Tokiは、ストップウォッチ・タイマーで測った時間に行動内容を付け、アプリ内カレンダーで振り返る本人用の時間管理アプリです。`rizakura-hontai`からは通常のリンクで移動し、Tokiの実行時コード・Worker・D1は独立させます。

## 現在の状態

Phase 42までに独立したAccess JWT検証、ローカルD1の計測schema/API、ストップウォッチ・タイマーの計測画面、アプリ内の日・週カレンダーと記録編集、Toki専用PWAのmanifest・アイコン、基盤への戻りリンクを実装し、単体・ローカルブラウザE2Eで検証しました。Phase 43ではToki専用D1・Worker・本人限定Accessを設定し、[本番URL](https://toki.sx7k2p9q.workers.dev/)を公開しました。所有者はPCで計測・保存・編集・タイマーを、iPhoneのホーム画面から起動するPWAで計測・保存・編集・再起動後の記録保持を確認しました。基盤入口とTokiの往復、Tech Inbox・Daymarkの表示も確認済みです。基盤との通信は行わず、ページ遷移だけです。スマートフォンのホーム画面起動用で、オフライン保存やService Workerは設けません。画面・manifest・アイコンもWorkerの認証を通った場合だけ配信します。`/__local/db`はローカル起動時にだけ明示的な変数で有効化する接続検査で、業務データは返しません。

Phase 44では、カレンダーでの計測なしの記録追加と、編集画面で確認後に行う保存済み記録の完全削除を実装しました。過去・未来の時間帯と既存記録との重複を許可します。2026-09-23のPhase 45で、所有者の承認後に専用D1のバックアップ・migrationとToki Workerの本番deployを実施しました。既存データの全項目一致、本人限定Accessの維持、未認証拒否、認証済みブラウザでの手動登録・編集・再読み込み・削除キャンセル・完全削除を確認済みです。検証用記録は削除し、既存記録と未完了計測は変更していません。追加機能についての所有者自身のPC/iPhone実機確認は未実施です。

Phase 47では、短時間の記録でも内容が1行見えるように、カレンダーの時間軸を1時間120px、記録の表示枠を最低44pxに変更しました。内容を時刻より先に表示し、隣接する短い記録は表示上の重なりを判定して横に分けます。長い内容は1行で省略し、全文・正確な時刻は記録を開いて確認できます。PCの日/週・スマートフォンの日表示が対象で、保存時刻・API・DB・認証は変更しません。2026-09-26に所有者の承認後、検証済みcommit `5ee7050`をToki Workerへ本番反映しました。認証済みブラウザの日/週表示と短い記録名、編集画面への遷移・保存せずキャンセル、未認証拒否を確認済みです。DB migration・記録の更新・認証/料金設定の変更は行っていません。

Phase 48では、手動の新規登録フォームを分単位（秒は00）にし、内容を任意にしました。手動・ストップウォッチ・タイマーの保存と記録編集で空欄/空白だけを受け付け、保存時に「無題」で補完するため、カレンダーと記録一覧にも「無題」が表示されます。既存記録の編集は引き続き秒単位で、内容だけの編集では元の秒・ミリ秒を保持します。2026-09-27に所有者の承認後、検証済みcommit `bab03ef`をToki Workerへ本番反映しました。認証済みブラウザで分単位・内容任意の手動登録フォームと計測画面を確認し、未認証10経路のAccess保護も検証済みです。DB schema/migration・記録の更新・進行中の計測・認証/料金設定は変更していません。空欄保存と再読み込み後の保持はローカルE2Eで検証し、本番では確認用の記録を保存していません。

2026-10-04に、基盤・Tech Inbox・Daymarkと技術スタックを揃える方針とPhase 49〜56の移行手順を記録しました。Phase 50で比較基準、Phase 51でViteの開発基盤、Phase 52でHono routing、Phase 53でDrizzleによるDB操作を整えました。2026-10-17にPhase 54のReact/TypeScript・React Router・Tailwindへの画面移行を完了しました。Phase 55では旧本番sourceとの組合せ検証、合成データのprivate backup復元予行、成果物/処理負荷の回帰予算と設定dry-runを品質gateへ加えます。独立repository/Worker/D1、機能・URL・記録・PWAを維持し、本番は変更していません。本番反映はPhase 56の別承認後です。

製品仕様とフェーズ計画は基盤repositoryの`docs/toki-design.md`・`docs/toki-roadmap.md`を正とします。このrepositoryへ基盤/Tech Inbox/Daymarkのsourceをコピーしたり、実データやCloudflare資格情報を追加したりしません。

## ローカル検証

Node.js `24.19.0`とpnpm `11.22.0`を使用します。依存・キャッシュ・一時ファイルはこのrepository内に保持します。

```sh
pnpm install --frozen-lockfile
PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/ms-playwright" pnpm exec playwright install chromium
pnpm check
```

`pnpm check`はformat、lint、生成型、browser/Worker/test/Node別のTypeScript、coverage付きtest、local D1 migrationと`time_sessions`検査、Vite build・成果物検査・Worker dry-run、ローカルChromium E2E、依存監査を実行します。E2Eはbuild済みWorkerとassetsを使い、毎回専用の一時D1、認証バイパスあり・なしの2つのloopback Workerを検証します。Phase 55以降は`release:local`と`e2e:migration`も含みます。Cloudflareのremote DBやWorkerは作成・変更しません。GitHub Actionsも同じgateを使い、deployは行いません。

### Phase 55の反映前検証

`tests/fixtures/phase48/`は最後に本番反映したcommit `bab03ef5084b980c481b8126fd34b18604c84249`の旧画面・API・DB・認証14ファイルです。改変検出のSHA-256と、変更しないmigration/PWAの9ファイルのhashを検査します。固定sourceは整形・coverageの対象から除き、現行runtimeのcoverage閾値は下げません。旧依存graphは再installせず、現行の検証済みtoolchainでsource互換性を確認します。

`pnpm e2e:migration`は旧画面＋新API、新画面＋旧API、旧画面＋旧APIの3構成で、PC 1280pxとスマホ320pxの計18テストを実行します。計測/タイマー/集中表示/再読込、空欄・分入力・秒精度、競合・確認付き削除・再送拒否、manifest/icon/Service Workerなしを実際のローカルD1へ接続して検証します。test専用Workerはloopback HTTPと明示flagだけで動き、本番へ配信しません。

単体/統合テストではmode 700/600の私有領域へ合成D1をexportし、空のローカルD1への復元後に全列・削除履歴・migration/index/trigger/整合性を照合します。未完了4状態を維持し、新版で編集したデータを旧版でも継続・保存・削除できるか検証します。実データは使わず、一時SQL/DBはテスト終了時に削除します。

`pnpm release:local`はbuild済みWorkerのraw/gzip 512/128 KiB、browser JS 320/110 KiB、CSS 32/10 KiBを独自予算として検査し、合成D1 IDのstage/live両設定で`deploy --dry-run`を実行します。実際の本番設定や資格情報は読み書きしません。APIの発行query数は通常1〜5、削除済み開始requestの拒否を最大7として検査します。1万件で各300 requestのNode+SQLite CPU比較も行いますが、認証bypassのローカル平均であり、Cloudflareの本番CPUや課金行数を保証しません。

本番直前のprivate SQL export・空のローカルD1での復元照合、active/rollback version ID、本人限定Access・D1 binding・料金/利用量はPhase 56の承認後に取得します。反映と切り戻しの手順は基盤repositoryの`docs/toki-operations.md`を正とし、本番DBの時点復元や新resource作成は今回のWorker反映に含めません。

必要な場合に限り、`pnpm dev`でbuild後のローカルWorkerを起動できます。Phase 51では本番と同じCSP・認証経路を検証するため、Vite HMRではなくbuild済み成果物を配信します。source編集後は停止・再実行してください。migration・検査・起動のローカルDB保存先をrepository内の`.wrangler/state`へ固定し、再buildで消される`dist`の中には保存しません。`/__local/db`と画面/APIの認証バイパスは明示的なローカル起動引数かつloopback HTTPに限定します。`.dev.vars`や`.env`は追跡しません。本番では画面/APIとも本人限定Accessに加えてWorkerでJWTを検証します。

### Phase 51の開発基盤

Phase 51ではrootの`index.html`・`calendar.html`から既存JavaScript/CSSを読み込み、画面を保持したままViteへ接続しました。Phase 54以降は同じ2 HTMLから共通のReact entrypointを起動します。ViteのReact/Tailwind/Cloudflare pluginsが`dist/client/`と`dist/toki/`を生成し、`public/`には変更しないmanifestとアイコンだけを残します。

見た目を保つため、Tailwindの[Preflight](https://tailwindcss.com/docs/preflight)は有効にせず既存のresetを維持します。Phase 54ではReact sourceだけを明示して走査し、テストは除外します。ビルド済みJS/CSSは8文字hash付きpathに限定し、すべてWorkerの認証を通します。未知URL・欠落asset・source・source mapをHTMLへfallbackしません。PWA identityと旧HTML URLは維持し、Service Workerは追加しません。

依存は基盤の確認済み完全版へ揃え、jsdom配下Undiciは修正版`8.10.2`に固定しました。7日gate・strict peer・integrity・install script制限を保ち、Drizzle Kitはこの段階では導入しません。詳細は基盤の`docs/dependency-baseline.md`を参照してください。

Phase 51の全品質gateは16 files/332 tests、PC/320pxブラウザ16件、audit指摘0件で成功しました。成果物の配信制限と、ローカルDBの保存先を再buildで消えない場所へ固定するテストも含みます。本番反映・iPhone実機の再確認は行っていません。

### Phase 52のHono routing

Hono `4.13.7`でWorkerの入口とAPIのroutingを統一しました。Zodの入力契約、jose/Access認証、既存のD1処理を使い、URL・method・JSON・status/error・ヘッダー・4096バイト上限を保持します。未知APIにも認証→DB binding→安全な更新要求の検査を適用し、経路ごとのquery・UUID・methodの検査順序も保ちます。

HonoのHEAD処理でGETが選ばれる場合も、元のmethodを確認してAPIは従来の405、ローカルprobeは503を返します。HEADで期限切れタイマーの状態を更新しません。エンコードしたpath・末尾slash・大文字IDを別経路へ補正せず、既存の404を維持します。HTML・hash付きasset・manifest/iconsは従来の認証とCSPを通して配信します。

旧routerで成功した52件の比較テスト、Workerの追加18件、実HTTPの経路テストを含め、全品質gateは17 files/402 tests、PC/320px E2E 17件で成功しました。再監査で開発依存にhigh 2件が見つかったため、Miniflare配下Sharpを`0.35.5`（libvipsバイナリ`1.3.4`）、source-map-jsを`1.2.2`へ限定更新し、最終auditは指摘0件です。7日gate・integrity・strict peer・install script制限は維持しています。DB schema/migration・本番環境は変更していません。

### Phase 53のDrizzleによるDB操作

Drizzle ORM `0.45.2`で既存のD1 tableを型付きschemaへ対応させ、記録・未完了計測の取得、更新、削除を移行しました。時刻は整数のUTCミリ秒、状態・null・版数とAPI契約は従来どおりです。開始と手動登録だけは、`INSERT OR IGNORE`と削除済みrequest IDの検査を1文で保つため、Drizzleのparameterized SQLを使います。部分indexに対応する固定status条件も維持しています。

`0001_initial.sql`・`0002_manual_records.sql`と適用履歴は変更しません。削除とrequest ID保持を原子的に行うtriggerは既存SQLを正とします。Kitはそのtriggerを表現せず、inline UNIQUEも名前付きindexとして生成するため、生成DDLを既存DBへ適用しません。開発専用のDrizzle Kit `0.31.10`と`drizzle.config.ts`はreview用で、出力先はGit無視対象`.tmp/drizzle-review`のみ。自動push/migrateやremote driverは設定していません。

`tests/fixtures/phase52-records.ts`は移行前commit `2c5da99`のDB実装をそのまま固定したテスト専用比較元です。26操作の結果・全列・操作ごとのquery数をSQLiteと隔離したローカルD1で比較し、未完了4状態、二重開始、編集/削除の競合、trigger失敗時の削除rollback、検索indexと物理schema/移行履歴の保持を検証します。1万件の履歴に対する検査も、実際にDrizzleが発行したSQLとparameterを使います。

全品質gateは19 files/443 tests、PC/320px E2E 17件で成功しました。coverageはstatements 95.02%・branches 94.09%・functions 98.52%・lines 96.58%。browser JS 29,575 bytes・CSS 19,840 bytesはPhase 52と一致し、Worker rawは384,298 bytes（dry-run gzip 80.66 KiB）です。Kitの本番bundle混入とDB errorのSQL/入力内容漏洩を拒否する回帰検査も含みます。

公式配布物・7日gate・互換性を確認し、追加61 package entriesのversion/integrityは基盤と一致しました。既存のresolution/integrityは不変で、補助依存tsxを基盤と同じ`4.23.12`へ揃えています。監査はhigh/critical 0、Kit由来の既知の開発専用moderate 1件です。該当する古いesbuildのHTTPサーバーは起動せず、KitはWorkerに含めません。`check`の末尾は同名のpnpm組み込みコマンドとの衝突を避けて`pnpm run audit`とし、既存の`--audit-level high`方針を明示して実行します。本番deploy・remote DB・Access/料金の変更は行っていません。

### Phase 54のReact画面

`src/client/application.tsx`のReact Routerが`/`・`/index.html`・`/calendar.html`を切り替えます。通常の内部リンクはRouterの公式`useHref`/`useLinkClickHandler`で処理し、修飾キー付きクリックはブラウザに任せます。基盤への戻りリンクは外部サイトへの通常のリンクです。初期データ取得・visibility/bfcache/onlineの同期とintervalはEffectに置き、cleanupで解除します。開始・停止・保存・削除はユーザーのイベントだけから実行します。

計測とカレンダーのstoreはrouteより上で保持し、`useSyncExternalStore`の不変snapshotで描画します。同期的なbusy判定で連打・StrictModeによる二重送信を防ぎ、通信結果が不明な開始・手動登録は同じrequest IDを維持します。手動登録の再試行は送信済みpayloadを固定し、編集/削除の競合は再読み込みを要求します。結果不明の保存を成功とは表示しません。旧DOM操作の`app.js`/`calendar.js`と旧CSSは取り除き、カレンダーの計算をTypeScriptへ移しました。

`tailwind.css`と`ui.css`はTailwindのcomponent/utilityを使い、色・余白・文字・responsiveの境界、1時間120px・最低44pxの短時間表示を維持します。文字はReactのtextとして描画し、編集・追加は従来のnative dialogのfocus/キャンセル/確認を使います。手動入力は分単位、編集は秒単位で、変更していない秒・ミリ秒を保持します。

固定したReact Router `8.3.0`には、未使用の`forwardRef`ラッパーにも残る動的route-module loaderがあります。`scripts/router-wrapper-annotations.ts`で同package内の`Link`・`NavLink`・`Form`の生成とdisplayName設定だけを純粋な式として注釈し、未使用分を除去します。使用するラッパーの挙動は変えず、ライブラリ本体やlockfileも書き換えません。パターンが変わればbuildを停止するテストがあり、成果物の動的importを無条件に許可する例外やCSPの緩和は設けません。

StrictModeの実画面テストとstore/APIのテスト、PC/320pxのE2Eで、計測/復帰/集中表示・日/週・追加/編集/削除・無題・時刻精度・連打・通信結果不明からの回復を検証します。画面移行では依存version・API/DB schema・SQL migration・認証/PWA・本番設定を変更しません。旧新APIの組み合わせ、clean checkout、性能予算と本番反映の準備はPhase 55、実際のdeployは別承認後のPhase 56で行います。

全品質gateは22 files/543 tests、PC/320px E2E 21件で成功しました。coverageはstatements 96.34%・branches 94.47%・functions 97.75%・lines 97.72%。合成データで旧版と新版のPC/320pxの23画面を比較し、計測/集中表示・日/週・追加/編集/削除確認の画像にpixel差がないことを確認しました。TypeScriptの型を除いたカレンダー計算の構文木も旧版と一致します。browser raw JSは258,294 bytes・CSS 23,292 bytesで、Reactを含む分だけ増えます。Worker raw 384,298 bytes（dry-run gzip 80.66 KiB）はPhase 53と不変です。監査はhigh/critical 0、既知の開発専用moderate 1件を継続し、該当するHTTP開発サーバーは起動しません。

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
