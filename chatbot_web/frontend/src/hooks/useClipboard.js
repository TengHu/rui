import { useCallback, useEffect, useRef } from 'react'

/**
 * Clipboard hook for handling paste operations on the desktop
 *
 * Supports:
 * - File paste from clipboard (images, files)
 * - Text paste (creates a .txt file)
 * - Both keyboard (Ctrl/Cmd+V) and context menu paste
 */
export function useClipboard({ sandboxId, onFilePasted, enabled = true }) {
  const lastPasteTime = useRef(0)

  // Upload file to sandbox
  const uploadFile = useCallback(async (file, customName = null) => {
    if (!sandboxId) {
      console.error('Clipboard: No sandbox ID available')
      return null
    }

    try {
      const formData = new FormData()

      // If custom name provided, create a new file with that name
      if (customName) {
        const newFile = new File([file], customName, { type: file.type })
        formData.append('file', newFile)
      } else {
        formData.append('file', file)
      }
      formData.append('sandbox_id', sandboxId)

      const response = await fetch('/api/sandbox/upload', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })

      const data = await response.json()

      if (data.success) {
        return {
          id: Date.now() + Math.random(),
          name: customName || file.name,
          path: data.path,
          size: file.size,
          type: file.type,
          uploadedAt: new Date().toISOString(),
        }
      } else {
        console.error('Clipboard upload failed:', data.error)
        return null
      }
    } catch (error) {
      console.error('Clipboard upload error:', error)
      return null
    }
  }, [sandboxId])

  // Handle paste from clipboard
  const handlePaste = useCallback(async (e) => {
    if (!enabled || !sandboxId) return

    // Debounce paste events (some browsers fire multiple)
    const now = Date.now()
    if (now - lastPasteTime.current < 100) return
    lastPasteTime.current = now

    // Skip if pasting in an input/textarea
    if (
      e?.target?.tagName === 'INPUT' ||
      e?.target?.tagName === 'TEXTAREA' ||
      e?.target?.isContentEditable
    ) {
      return
    }

    const clipboardData = e?.clipboardData || window.clipboardData
    const uploadedFiles = []

    // Check for files in clipboard
    if (clipboardData?.files && clipboardData.files.length > 0) {
      e?.preventDefault?.()

      for (const file of clipboardData.files) {
        // Generate name for pasted images
        let fileName = file.name
        if (!fileName || fileName === 'image.png' || fileName === 'blob') {
          const ext = file.type.split('/')[1] || 'png'
          fileName = `pasted-${Date.now()}.${ext}`
        }

        const result = await uploadFile(file, fileName)
        if (result) {
          uploadedFiles.push(result)
        }
      }
    }
    // Check for items (for images copied from web)
    else if (clipboardData?.items) {
      for (const item of clipboardData.items) {
        if (item.type.startsWith('image/')) {
          e?.preventDefault?.()
          const blob = item.getAsFile()
          if (blob) {
            const ext = item.type.split('/')[1] || 'png'
            const fileName = `pasted-${Date.now()}.${ext}`
            const result = await uploadFile(blob, fileName)
            if (result) {
              uploadedFiles.push(result)
            }
          }
        }
      }
    }

    // Callback with uploaded files
    if (uploadedFiles.length > 0 && onFilePasted) {
      onFilePasted(uploadedFiles)
    }

    return uploadedFiles
  }, [enabled, sandboxId, uploadFile, onFilePasted])

  // Trigger paste programmatically (for context menu)
  const triggerPaste = useCallback(async () => {
    if (!enabled || !sandboxId) return []

    try {
      // Try to read from clipboard API
      const clipboardItems = await navigator.clipboard.read()
      const uploadedFiles = []

      for (const item of clipboardItems) {
        // Check for image types
        const imageType = item.types.find(t => t.startsWith('image/'))
        if (imageType) {
          const blob = await item.getType(imageType)
          const ext = imageType.split('/')[1] || 'png'
          const fileName = `pasted-${Date.now()}.${ext}`
          const result = await uploadFile(blob, fileName)
          if (result) {
            uploadedFiles.push(result)
          }
        }

        // Check for text (create as .txt file)
        if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain')
          const text = await blob.text()
          if (text.trim()) {
            // Create text file
            const textBlob = new Blob([text], { type: 'text/plain' })
            const fileName = `pasted-text-${Date.now()}.txt`
            const result = await uploadFile(textBlob, fileName)
            if (result) {
              uploadedFiles.push(result)
            }
          }
        }
      }

      if (uploadedFiles.length > 0 && onFilePasted) {
        onFilePasted(uploadedFiles)
      }

      return uploadedFiles
    } catch (error) {
      // Clipboard API not available or permission denied
      console.warn('Clipboard API not available:', error.message)
      return []
    }
  }, [enabled, sandboxId, uploadFile, onFilePasted])

  // Check if clipboard has content
  const checkClipboardHasContent = useCallback(async () => {
    try {
      const clipboardItems = await navigator.clipboard.read()
      return clipboardItems.length > 0
    } catch {
      // Can't check clipboard without permission
      return true // Assume there might be content
    }
  }, [])

  // Set up global paste listener
  useEffect(() => {
    if (!enabled) return

    const listener = (e) => handlePaste(e)
    window.addEventListener('paste', listener)
    return () => window.removeEventListener('paste', listener)
  }, [enabled, handlePaste])

  return {
    handlePaste,
    triggerPaste,
    checkClipboardHasContent,
    uploadFile,
  }
}

export default useClipboard
