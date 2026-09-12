# macOS 配布用の署名と公証

OneTeam は Mac App Store ではなく GitHub Releases で配布するため、`Developer ID Application` 証明書で署名し、Apple の公証を通す。App Store 用の `Apple Distribution` 証明書やプロビジョニングプロファイルはこの配布経路では使用しない。

アプリ識別子は `jp.co.pluswing.oneteam` である。`package.json` には署名組織名、Team ID、証明書ハッシュを記載しない。Electron Builder はログインキーチェーンにある `Developer ID Application` 証明書を自動検出する。Hardened Runtime と Electron の実行に必要な entitlements は `build/` に定義している。

## 初回だけ行う設定

Developer ID 証明書がログインキーチェーンにあることを確認する。

```sh
security find-identity -v -p codesigning
```

表示結果に配布に使う `Developer ID Application` 証明書があればよい。以下は形式例であり、実際の組織名・Team ID を公開リポジトリへ記録しない。

```text
Developer ID Application: YOUR_ORGANIZATION (YOUR_TEAM_ID)
```

複数の Developer ID 証明書がある環境では、リポジトリ外の環境変数で対象を絞り込める。

```sh
export CSC_NAME="YOUR_ORGANIZATION (YOUR_TEAM_ID)"
```

Apple Account でアプリ用パスワードを発行してから、その値をキーチェーンの notarization プロファイルとして保存する。アプリ用パスワードはリポジトリや `.env` に書かない。

```sh
xcrun notarytool store-credentials "oneteam-notarization" \
  --apple-id "YOUR_APPLE_ID" \
  --team-id "YOUR_TEAM_ID" \
  --password "YOUR_APP_SPECIFIC_PASSWORD"
```

保存を確認する。

```sh
xcrun notarytool history --keychain-profile "oneteam-notarization"
```

## リリースビルド

そのターミナルでキーチェーンプロファイルを指定してパッケージ化する。

```sh
export APPLE_KEYCHAIN_PROFILE=oneteam-notarization
npm run app:pack
```

Electron Builder は `.app` を Developer ID で署名し、Apple に公証を送信して完了を待ち、チケットをアプリに stapling する。生成物は `release/` に出力される。

## リリース前の検証

```sh
codesign --verify --deep --strict --verbose=2 "release/mac/OneTeam.app"
spctl --assess --type execute --verbose=4 "release/mac/OneTeam.app"
xcrun stapler validate "release/mac/OneTeam.app"
```

Apple Silicon または Intel を明示してビルドした場合は、`release/mac-arm64/OneTeam.app` または `release/mac/OneTeam.app` のように、実際に生成されたパスを指定する。

公証に失敗した場合は `xcrun notarytool log <submission-id> --keychain-profile oneteam-notarization` で Apple の診断ログを確認する。

## GitHub Actions でのリリース

`.github/workflows/release-dmg.yml` は GitHub Release の公開を契機に、DMG 内の `.app` を Developer ID で署名し、公証してリリースへアップロードする。署名組織名、Team ID、証明書、パスワード、API キーはワークフローファイルへ記載しない。

GitHub リポジトリの **Settings → Secrets and variables → Actions** で、次の Repository secrets を登録する。

| Secret | 値 |
| --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | Developer ID Application 証明書と秘密鍵を含む `.p12` の Base64 文字列 |
| `MACOS_CERTIFICATE_PASSWORD` | `.p12` をエクスポートしたときに設定したパスワード |
| `APPLE_API_KEY_P8_BASE64` | 公証用 App Store Connect **Team Key** の `.p8` ファイルの Base64 文字列 |
| `APPLE_API_KEY_ID` | Team Key の Key ID |
| `APPLE_API_ISSUER` | App Store Connect の Issuer ID |

`.p12` を作るには、キーチェーンアクセスで配布用の `Developer ID Application` 証明書と対応する秘密鍵を選び、**ファイル → 書き出す項目**から Personal Information Exchange (`.p12`) として書き出す。`.p12` と `.p8` の Base64 文字列は、macOS ではそれぞれ次のようにクリップボードへコピーできる。

```sh
base64 < /path/to/signing-certificate.p12 | tr -d '\n' | pbcopy
base64 < /path/to/AuthKey_XXXXXXXXXX.p8 | tr -d '\n' | pbcopy
```

公証には App Store Connect の **Users and Access → Integrations → App Store Connect API → Team Keys** で作成した Team Key を使用する。個人用 API Key は `notarytool` に使用できない。Team Key は **App Manager** 権限で作成し、`.p8` は一度しかダウンロードできないため、安全な場所にも保管する。

設定後に GitHub Release を Publish するとワークフローが開始する。必要な Secrets が不足している場合は、署名ビルドより前に明示的に失敗する。ビルド時だけランナーの一時ディレクトリへ証明書と API Key を復元し、Electron Builder がその一時キーチェーンの Developer ID 証明書を使う。アップロード前に `codesign`、Gatekeeper (`spctl`)、stapling を検証する。完了時には復元したファイルを削除する。
