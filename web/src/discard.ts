import type { FormInstance } from 'antd'
import type { useAppProps } from 'antd/es/app/context'

/**
 * 关掉抽屉之前，问一句要不要丢掉手敲的内容。
 *
 * 抽屉里填好的东西只活在表单里，关掉就没了。setFieldsValue 不算 touched，
 * 所以问的是「你手敲过没有」，不是「有没有预填」。
 *
 * 挡得住关闭图标、Esc 和遮罩。浏览器后退键挡不住，BrowserRouter 没有 blocker。
 */
export function confirmDiscard<T>(
  modal: useAppProps['modal'],
  form: FormInstance<T>,
  what: string,
  onDiscard: () => void,
): void {
  if (!form.isFieldsTouched()) {
    onDiscard()
    return
  }
  modal.confirm({
    title: `丢掉刚${what}的内容？`,
    content: '关掉之后这些要重来一遍。',
    okText: '丢掉',
    okButtonProps: { danger: true },
    cancelText: `继续${what}`,
    onOk: onDiscard,
  })
}
