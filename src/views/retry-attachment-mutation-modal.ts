import { App, Modal, Setting } from 'obsidian';
import type FastSync from '../main';
import { retryAttachmentMutationConflict } from '../lib/sync/operator_file';
import { showSyncNotice } from '../lib/utils/helpers';

export class RetryAttachmentMutationModal extends Modal {
  constructor(app: App, private plugin: FastSync) { super(app); }

  onOpen(): void {
    this.titleEl.setText('重试获取冲突附件的远端版本');
    this.contentEl.createEl('p', { text: '输入同步日志中显示的原始附件路径，即使本地文件已删除也可以重试。' });
    let path = '';
    new Setting(this.contentEl).setName('原始附件路径').addText(text => text.setPlaceholder('例如：附件/图片.png').onChange(value => { path = value.trim(); }));
    new Setting(this.contentEl).addButton(button => button.setButtonText('获取远端版本').setCta().onClick(() => {
      if (!path) { showSyncNotice('请输入原始附件路径。', 6000); return; }
      this.close();
      void retryAttachmentMutationConflict(path, this.plugin)
        .then(() => showSyncNotice('已请求获取远端版本，请查看同步日志。', 6000))
        .catch(error => showSyncNotice(`附件冲突重试失败：${error instanceof Error ? error.message : String(error)}`, 10000));
    }));
  }

  onClose(): void { this.contentEl.empty(); }
}
