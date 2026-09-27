// 单独一个文件，因为 store.ts 和 conversations.ts 都要抛它，两边互相不引用。
/** 调用方能区分的几种失败。 */
export class StoreError extends Error {
  status: 404 | 409 | 422;
  missing?: string[];

  constructor(status: 404 | 409 | 422, message: string, missing?: string[]) {
    super(message);
    this.status = status;
    this.missing = missing;
  }
}
