@Entry
@Component
struct Index {
  build() {
    Column({ space: 8 }) {
      Text('Xpod P2P Smoke')
        .fontSize(20)
        .fontWeight(FontWeight.Bold)
      Text('Started by HDC aa start. Watch hilog tag XpodP2PSmoke for RESULT_JSON.')
        .fontSize(12)
        .fontColor('#64748B')
    }
    .padding(16)
    .width('100%')
    .height('100%')
  }
}
