# ole-doc-metadata

在浏览器中读取和修改旧版 Word `.doc` 文件的 Office 属性。文件不会上传：库只处理传入的字节，并返回一份新的 `.doc` 数据。

## 支持范围

- Word 97–2003 二进制 `.doc`，未加密且结构可识别。
- 文档属性存放在 OLE HPSF 属性流中；正文、批注、修订记录、嵌入对象和 VBA 流不会被本库编辑。
- 加密、XOR 混淆、非 Word 复合文件以及无法安全解析的属性流会报错，不返回输出文件。
- 有数字签名的文档可以读取和修改属性，但修改会使原签名失效。调用方应在下载前提示用户。
- 其他 `.doc` 方言或特殊版本尚未通过 Word/LibreOffice 实测，不应视为兼容。

## 字段映射

标题、主题、作者、关键词、说明、最后保存者、修订号、创建/最后打印/最后保存时间、总编辑分钟数和程序名称使用 SummaryInformation 标准属性。类别、主管、公司、程序版本、内容状态和文档版本使用 DocumentSummaryInformation 标准属性；内容状态为 PID 27，文档版本为 PID 29。旧版 `.doc` 没有标准版权属性，因此 `copyright` 保存为名为 `Copyright` 的自定义属性。

表单模式只改传入的字段，空字符串会移除该字段；其他属性保留。模板模式替换旧属性，只写入非空模板值。清空模式删除标准和自定义属性。三种模式都会把最后保存时间设为本次操作时间。

## API

```js
const result = OLEDocMetadata.readDocMetadata(bytes);
// result.metadata 是字段到字符串的映射；result.signed 表示发现数字签名流。

const output = OLEDocMetadata.writeDocMetadata(
  bytes,
  { title: '合同', copyright: '© 2026 示例律所' },
  'form', // 'form' | 'template' | 'clear'
);
```

CommonJS：

```js
const OLEDocMetadata = require('ole-doc-metadata');
```

浏览器：先加载 `vendor/cfb.min.js`，再加载 `dist/ole-doc-metadata.js`。浏览器构建可用 `npm run build:browser` 重新生成。库不使用 `fetch`、XHR、服务端接口或远程脚本处理文档字节。

## 本地演示

在仓库根目录运行 `python -m http.server 8080`，然后打开 `http://localhost:8080/demo/`。选择 `.doc` 文件后可编辑属性、应用模板或清空属性；只有按下“应用并下载”才会生成新文件。

## 验证

运行 `npm test`。测试覆盖 CFB 分类、HPSF 解析与序列化、三种写入模式、代码页转换、未知属性保留、恶意/损坏输入拒绝、签名标记和非属性流字节比较，并在无 Node 内置 `Buffer`/`process` 的浏览器模拟环境中验证构建文件。另用 Apache POI 仓库提供的真实 `.doc` 样本验证属性写入，并由独立 HPSF 读取器检查输出。

门户接入另有回归测试，命令为：

```sh
python -m unittest discover -s work/portal-overlay/tests -p 'test_metadata_package.py' -v
```

集成样本位于 `tests/fixtures/Bug49820.doc`，来源和 Apache-2.0 许可见该目录。当前没有在 Microsoft Word 或 LibreOffice 中打开生成文件的实测结果，因此本项目尚未通过真实文字处理器兼容性验收。欢迎提交不同 Word 版本的测试报告和样本（请先移除敏感内容）。

## 许可

本项目代码使用 MIT 许可证。CFB 容器依赖及测试样本的来源和许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
