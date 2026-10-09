(() => {
  'use strict';

  const fileInput = document.getElementById('doc-file');
  const fileName = document.getElementById('file-name');
  const form = document.getElementById('metadata-form');
  const modeInput = document.getElementById('operation-mode');
  const applyButton = document.getElementById('apply-download');
  const status = document.getElementById('status-message');
  const signatureWarning = document.getElementById('signature-warning');
  const fields = [...form.elements].filter(element => element.name);
  const dateFields = new Set(['created', 'modified', 'lastPrinted']);
  let file = null;
  let bytes = null;
  let signed = false;
  let touched = new Set();

  function setStatus(message, state = '') {
    status.textContent = message;
    status.dataset.state = state;
  }

  function localDateValue(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = part => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function readFields() {
    return Object.fromEntries(fields.map(field => [field.name, field.value]));
  }

  fileInput.addEventListener('change', async () => {
    file = fileInput.files?.[0] || null;
    bytes = null;
    signed = false;
    touched = new Set();
    applyButton.disabled = true;
    signatureWarning.hidden = true;
    if (!file) return;
    if (!/\.doc$/i.test(file.name)) {
      fileName.textContent = file.name;
      setStatus('请选择旧版 Word .doc 文件。', 'error');
      return;
    }
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
      const result = OLEDocMetadata.readDocMetadata(bytes);
      signed = result.signed;
      for (const field of fields) {
        const value = result.metadata[field.name] || '';
        field.value = dateFields.has(field.name) ? localDateValue(value) : value;
      }
      fileName.textContent = `${file.name} · ${new Intl.NumberFormat('zh-CN').format(file.size)} 字节`;
      signatureWarning.hidden = !signed;
      applyButton.disabled = false;
      setStatus(signed
        ? '属性已读取。继续操作会使原数字签名失效。'
        : '属性已读取。修改仅在按下应用按钮后写入新文件。');
    } catch (error) {
      fileName.textContent = file.name;
      setStatus(error.message || '无法读取此 .doc 文件。', 'error');
    }
  });

  form.addEventListener('input', event => {
    if (event.target.name) touched.add(event.target.name);
  });

  applyButton.addEventListener('click', () => {
    if (!file || !bytes) return;
    if (signed && !window.confirm('修改属性会使原数字签名失效。是否继续？')) return;

    try {
      const mode = modeInput.value;
      const entered = readFields();
      entered.modified = localDateValue(new Date().toISOString());
      let values = mode === 'clear' ? {} : entered;
      if (mode === 'form') {
        values = Object.fromEntries([...touched].map(key => [key, entered[key]]));
      }
      const output = OLEDocMetadata.writeDocMetadata(bytes, values, mode);
      const blob = new Blob([output], { type: 'application/msword' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name.replace(/\.doc$/i, '') + '_properties-edited.doc';
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('新文件已生成并开始下载。原文件未更改。', 'success');
    } catch (error) {
      setStatus(error.message || '无法安全生成输出文件。', 'error');
    }
  });
})();
