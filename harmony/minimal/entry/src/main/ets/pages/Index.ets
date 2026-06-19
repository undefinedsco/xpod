import { webview } from '@kit.ArkWeb';

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  @State verifierUrl: string = 'http://192.168.3.15:3000/app/inrupt-smoke.html';
  @State currentUrl: string = 'http://192.168.3.15:3000/app/inrupt-smoke.html';

  build() {
    Column({ space: 10 }) {
      Text('Xpod Inrupt Smoke')
        .fontSize(20)
        .fontWeight(FontWeight.Bold)
        .width('100%')

      Text('WebView shell for the shared Inrupt browser SDK verifier. Login Cloud, then session.fetch the SP resource from the loaded page.')
        .fontSize(12)
        .fontColor('#64748B')
        .width('100%')

      TextInput({ placeholder: 'http://host:3000/app/inrupt-smoke.html?issuer=...&sp=...', text: this.verifierUrl })
        .onChange((value: string) => { this.verifierUrl = value; })
        .width('100%')

      Row({ space: 8 }) {
        Button('Open verifier')
          .layoutWeight(1)
          .onClick(() => {
            this.currentUrl = this.verifierUrl;
            this.controller.loadUrl(this.currentUrl);
          })

        Button('Reload')
          .layoutWeight(1)
          .onClick(() => {
            this.controller.refresh();
          })
      }
      .width('100%')

      Web({ src: this.currentUrl, controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .width('100%')
        .layoutWeight(1)
    }
    .padding(12)
    .width('100%')
    .height('100%')
  }
}
