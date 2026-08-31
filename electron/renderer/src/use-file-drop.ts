import { useCallback, useRef, useState } from 'react'

/**
 * 把一个区域变成拖放目标。返回「往容器上摊的 props」+「现在悬着没有」。
 *
 * ## 三个必须处理的坑
 *
 * **1. dragleave 会在划过子元素时触发。** 拖着文件从 composer 划到里面的
 * textarea，浏览器先给 textarea 发 dragenter、再给 composer 发 dragleave ——
 * 只看这两个事件的话高亮会在拖动过程中疯狂闪。所以用一个**计数器**记
 * enter/leave 的深度，归零才算真的离开。这是这类实现的标准做法。
 *
 * **2. 不 preventDefault 的话浏览器会自己接管。** dragover 上不拦，drop
 * 就走浏览器默认行为 —— Electron 里表现为整个窗口导航到那个文件（app 白屏，
 * 只能重启）。dragover **和** drop 两个都要拦，少一个都不行。
 *
 * **3. 拖文本进来也会触发。** 从别处拖一段选中的文字过来同样是 drag 事件，
 * 但 dataTransfer 里没有文件。看 types 里有没有 'Files' 来分辨 ——
 * 不看的话拖一段文字进来会亮起「松手上传」，松手之后什么也没发生。
 */
export function useFileDrop(onFiles: (files: File[]) => void, disabled = false) {
  const [dragging, setDragging] = useState(false)
  // 用 ref 而不是 state 存深度：它在同一批事件里要被连续读写，
  // state 的异步批处理会让读到的值是上一帧的
  const depth = useRef(0)

  /** 这次拖动带的是文件吗（不是从别处拖来的一段文字）。 */
  const hasFiles = (e: React.DragEvent) => {
    const types = e.dataTransfer?.types
    return types ? Array.from(types).includes('Files') : false
  }

  const onDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !hasFiles(e)) return
      e.preventDefault()
      depth.current += 1
      setDragging(true)
    },
    [disabled],
  )

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !hasFiles(e)) return
      // 必须拦，否则 drop 不会触发（浏览器默认不允许放）
      e.preventDefault()
      // 让光标显示成「复制」而不是「移动」—— 我们是把文件收下来，
      // 不是把它从原处搬走
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    },
    [disabled],
  )

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !hasFiles(e)) return
      e.preventDefault()
      depth.current -= 1
      // 归零才算真离开（见文件头坑 1）
      if (depth.current <= 0) {
        depth.current = 0
        setDragging(false)
      }
    },
    [disabled],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (disabled) return
      // 无条件拦：哪怕这次拖的不是文件，也不能让浏览器拿去导航（坑 2）
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length > 0) onFiles(files)
    },
    [disabled, onFiles],
  )

  return {
    dragging,
    dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}
