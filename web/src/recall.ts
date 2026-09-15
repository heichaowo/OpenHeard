import { useCallback, useState } from 'react'
import { recallStation } from '@core'
import type { Qso } from '@core'
import type { FormInstance } from 'antd'

/** 三个表单共有的那几格。QuickEntry 的表单还有时间和频率，这里用不着。 */
interface Recallable {
  call?: string
  qth?: string
  gridsquare?: string
}

/**
 * 呼号填完之后，把上次和他通联时记下的 QTH 和网格补进空着的格子。
 *
 * 数据本来就在日志里，不用另存一份字典。本地中继上会重复遇到的就那几个人。
 *
 * 只填空的，不覆盖已经填了的：地址会变，人现在打的那个一定比日志里的新。
 * 返回上次通联的时刻，界面用它说明这两个值是哪来的，免得看着像凭空冒出来。
 */
export function useRecall<T extends Recallable>(form: FormInstance<T>, qsos: Qso[]) {
  const [recalledAt, setRecalledAt] = useState<number | undefined>()

  const onValuesChange = useCallback(
    (changed: Partial<T>) => {
      if (changed.call === undefined) return

      const hit = recallStation(qsos, changed.call)
      const now = form.getFieldsValue() as Recallable
      const patch: Recallable = {}
      if (hit) {
        if (!now.qth && hit.qth) patch.qth = hit.qth
        if (!now.gridsquare && hit.gridsquare) patch.gridsquare = hit.gridsquare
      }

      if (Object.keys(patch).length === 0) {
        // 呼号改成了另一个人，上一条提示就不再成立。
        setRecalledAt(undefined)
        return
      }
      form.setFieldsValue(patch as Partial<T>)
      setRecalledAt(hit?.lastAt)
    },
    [form, qsos],
  )

  const reset = useCallback(() => setRecalledAt(undefined), [])

  return { recalledAt, onValuesChange, reset }
}
