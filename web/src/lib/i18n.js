import { setTimeLocale } from './time.js'

// Interface language is intentionally fixed; user content keeps its original text.
export const lang = 'en'
setTimeLocale('en')

export const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
export const MOD = isMac ? '⌘' : 'Ctrl'
export const ALT = isMac ? '⌥' : 'Alt'
export const BACKSPACE = isMac ? '⌫' : 'Backspace'
const key = (k) => (isMac ? MOD + k : `${MOD}+${k}`)

const STRINGS = {
  en: {
    'header.openOnPhone': 'Open on phone',
    'header.drive': 'Drive',
    'omnibar.placeholder': `Search — or press ${key('V')} to send your clipboard`,
    'omnibar.placeholderTouch': 'Search',

    'group.pinned': 'Pinned',
    'group.today': 'Today',
    'group.yesterday': 'Yesterday',
    'group.week': 'Previous 7 days',
    'group.older': 'Older',

    'empty.title': `Press ${key('V')} to send your clipboard here`,
    'empty.hint': 'or drag a file anywhere onto this window',
    'empty.pair': 'scan to pair, once',
    'empty.terminal': 'From a terminal:',
    'empty.mobileTitle': 'Nothing here yet',
    'empty.mobileHint': 'Send something from your computer, or tap ＋ to add.',

    'search.emptyTitle': 'No matches',
    'search.emptyHint': 'Press ↵ to send “{q}” as a new clip',

    'action.copy': 'Copy',
    'action.copied': 'Copied',
    'action.open': 'Open',
    'action.openBrowser': 'Open in browser',
    'action.download': 'Download',
    'action.saveToFiles': 'Save to Files',
    'action.copyImage': 'Copy image',
    'action.pin': 'Pin',
    'action.unpin': 'Unpin',
    'action.delete': 'Delete',
    'action.deleteAll': 'Delete all unpinned',
    'action.showQr': 'Show QR code',
    'action.showFull': 'Show full text',
    'action.curl': 'Show terminal commands',
    'action.send': 'Send',
    'action.tapToCopy': 'Tap to copy',
    'action.loading': 'Loading…',
    'action.close': 'Close',
    'action.more': 'More actions',

    'meta.type': 'Type',
    'meta.added': 'Added',
    'meta.expires': 'Expires',
    'meta.copied': 'Copied',
    'meta.copiedTimes': '{n}×',
    'meta.never': 'never',
    'meta.keepForever': '{key} to keep forever',
    'meta.from': 'from {device}',
    'meta.lines': '{n} lines',

    'footer.devices': '{n} devices',
    'footer.device': '1 device',
    'footer.noDevices': 'no devices connected',
    'footer.sent': 'Sent',
    'footer.moved': 'Moved to top',
    'footer.willSend': '↵ sends “{q}”',

    'drop.title': 'Drop to send',
    'drop.files': '{n} files',
    'drop.rejected': 'Only images and text — “{name}” was skipped',

    'hint.longPressIOS': 'Long-press the image → Add to Photos or Copy',
    'hint.longPressAndroid': 'Long-press the image → Copy image or Share image',
    'hint.longPressDesktop': 'Right-click the image → Copy image, or drag it out',
    'hint.wechat': 'Open in Safari to copy images',
    'hint.qrCaption': 'Point your phone’s camera at the code to open this link.',

    'manual.title': 'Copy it yourself',
    'manual.touch': 'Selected — long-press → Copy',
    'manual.desktop': `Selected — press ${key('C')}`,

    'snackbar.deleted': 'Deleted',
    'snackbar.undo': 'Undo',

    'add.title': 'Add to netclip',
    'add.placeholder': 'Paste or type…',
    'add.photos': 'Photos',
    'add.files': 'Files',
    'add.camera': 'Camera',

    'mobile.new': '{n} new',
    'mobile.live': 'live',
    'mobile.reconnecting': 'reconnecting…',

    'filter.all': 'All',
    'filter.text': 'Text',
    'filter.images': 'Images',
    'filter.file': 'Files',
    'filter.pinned': 'Pinned',

    'confirm.deleteAll': 'Delete every unpinned item? Pinned items are kept.',
    'qr.title': 'Open on phone',
    'qr.hint': 'Scan with your phone’s camera to open this page',
    'qr.unreachable': 'netclip can’t tell what address your phone should use.',
    'qr.unreachableHint':
      'You opened this page on localhost, and the server can only see a container-internal address for itself. Open this page by the machine’s LAN address instead, then the code will be right.',
    'kind.image': 'Image',
    'kind.file': 'File',
    'kind.url': 'Link',
    'kind.json': 'JSON',
    'kind.color': 'Colour',
    'kind.text': 'Text',
  },

  zh: {
    'header.openOnPhone': '在手机上打开',
    'header.drive': '云盘',
    'omnibar.placeholder': `搜索 — 或按 ${key('V')} 发送剪贴板`,
    'omnibar.placeholderTouch': '搜索',

    'group.pinned': '已固定',
    'group.today': '今天',
    'group.yesterday': '昨天',
    'group.week': '最近 7 天',
    'group.older': '更早',

    'empty.title': `按 ${key('V')} 把剪贴板内容发到这里`,
    'empty.hint': '或者把文件拖到窗口的任意位置',
    'empty.pair': '扫码配对，只需一次',
    'empty.terminal': '在终端里：',
    'empty.mobileTitle': '还没有内容',
    'empty.mobileHint': '从电脑发点什么过来，或点 ＋ 添加。',

    'search.emptyTitle': '没有匹配项',
    'search.emptyHint': '按 ↵ 把“{q}”作为新内容发送',

    'action.copy': '复制',
    'action.copied': '已复制',
    'action.open': '打开',
    'action.openBrowser': '在浏览器中打开',
    'action.download': '下载',
    'action.saveToFiles': '存储到「文件」',
    'action.copyImage': '复制图片',
    'action.pin': '固定',
    'action.unpin': '取消固定',
    'action.delete': '删除',
    'action.deleteAll': '删除全部未固定项',
    'action.showQr': '显示二维码',
    'action.showFull': '显示全文',
    'action.curl': '显示终端命令',
    'action.send': '发送',
    'action.tapToCopy': '点这里复制',
    'action.loading': '加载中…',
    'action.close': '关闭',
    'action.more': '更多操作',

    'meta.type': '类型',
    'meta.added': '添加于',
    'meta.expires': '过期',
    'meta.copied': '已复制',
    'meta.copiedTimes': '{n} 次',
    'meta.never': '永不',
    'meta.keepForever': '按 {key} 永久保留',
    'meta.from': '来自 {device}',
    'meta.lines': '{n} 行',

    'footer.devices': '{n} 台设备',
    'footer.device': '1 台设备',
    'footer.noDevices': '没有设备连接',
    'footer.sent': '已发送',
    'footer.moved': '已移到顶部',
    'footer.willSend': '↵ 发送“{q}”',

    'drop.title': '松手即发送',
    'drop.files': '{n} 个文件',
    'drop.rejected': '只支持图片和文本 — 已跳过“{name}”',

    'hint.longPressIOS': '长按图片 → 存储到「照片」或「拷贝」',
    'hint.longPressAndroid': '长按图片 → 复制图片 或 分享图片',
    'hint.longPressDesktop': '右键图片 → 复制图片，或者直接拖出去',
    'hint.wechat': '用 Safari 打开才能复制图片',
    'hint.qrCaption': '用手机相机对准二维码即可打开这个链接。',

    'manual.title': '手动复制',
    'manual.touch': '已全选 — 长按 → 拷贝',
    'manual.desktop': `已全选 — 按 ${key('C')}`,

    'snackbar.deleted': '已删除',
    'snackbar.undo': '撤销',

    'add.title': '添加到 netclip',
    'add.placeholder': '粘贴或输入…',
    'add.photos': '照片',
    'add.files': '文件',
    'add.camera': '相机',

    'mobile.new': '{n} 条新内容',
    'mobile.live': '已连接',
    'mobile.reconnecting': '重连中…',

    'filter.all': '全部',
    'filter.text': '文本',
    'filter.images': '图片',
    'filter.file': '文件',
    'filter.pinned': '已固定',

    'confirm.deleteAll': '删除所有未固定的内容？已固定的会保留。',
    'qr.title': '在手机上打开',
    'qr.hint': '用手机相机扫描即可打开本页',
    'qr.unreachable': 'netclip 不知道该让手机连哪个地址。',
    'qr.unreachableHint':
      '你是用 localhost 打开这个页面的，而服务端只能看到容器内网地址。改用这台机器的内网 IP 打开本页，二维码就是对的。',
    'kind.image': '图片',
    'kind.file': '文件',
    'kind.url': '链接',
    'kind.json': 'JSON',
    'kind.color': '颜色',
    'kind.text': '文本',
  },
}

export function t(id, vars) {
  const table = STRINGS[lang] || STRINGS.en
  let out = table[id] ?? STRINGS.en[id] ?? id
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v))
  }
  return out
}
