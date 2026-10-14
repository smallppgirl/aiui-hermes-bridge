<script def>
{
  "navigationBarTitleText": "Hermes Bridge"
}
</script>

<script setup>
import { BRIDGE_CONFIG, buildPayload } from '../../config.js'

export default {
  data: {
    focused: false,
    status: 'ready',        // ready | listening | working | done
    answerText: '',
  },

  // ---- call the Hermes/Claude bridge and render the answer ----
  async ask(text) {
    if (!text) return
    this.setData({ status: 'working', answerText: '' })
    if (this._abort) this._abort.abort()
    const ctrl = (this._abort = new AbortController())
    const timer = setTimeout(() => ctrl.abort(), 120000)   // 2-minute cap
    try {
      const resp = await fetch(BRIDGE_CONFIG.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + BRIDGE_CONFIG.ak,
        },
        body: JSON.stringify(buildPayload(text)),
        signal: ctrl.signal,
      })
      const reader = resp.body && typeof resp.body.getReader === 'function'
        ? resp.body.getReader()
        : null
      const dec = new TextDecoder()
      let buffer = ''
      const feed = (chunk) => {
        buffer += chunk
        let i
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          this._consumeSse(buffer.slice(0, i).replace(/\r/g, ''))
          buffer = buffer.slice(i + 2)
        }
      }
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          feed(dec.decode(value, { stream: true }))
        }
        if (buffer) this._consumeSse(buffer.replace(/\r/g, ''))
      } else {
        // some mini-app runtimes buffer the whole body instead of streaming
        feed(await resp.text())
      }
      this.setData({ status: 'done' })
    } catch (e) {
      const msg = (e && e.name === 'AbortError')
        ? '（已停止）'
        : ('（连接失败：' + (e && e.message || e) + '）')
      this.setData({ status: 'ready', answerText: msg })
    } finally {
      clearTimeout(timer)
      this._abort = null
    }
  },

  // stop the current in-flight request
  stop() {
    if (this._abort) this._abort.abort()
  },

  // parse one SSE block:  data:{...answer_stream...}
  _consumeSse(block) {
    if (!block) return
    const m = block.match(/data:\s*(\{.*\})/s)
    if (!m) return
    try {
      const obj = JSON.parse(m[1])
      if (obj && obj.type === 'answer' && obj.answer_stream) {
        const cur = this.data.answerText + obj.answer_stream
        // cap displayed text to avoid unbounded growth on very long answers
        this.setData({ answerText: cur.length > 4000 ? cur.slice(cur.length - 4000) : cur })
      }
      if (obj && obj.is_finish) {
        this.setData({ status: 'done' })
      }
    } catch (e) { /* ignore */ }
  },

  // ---- capture voice via the AIUI/SDK speech API ---------------
  // TODO: replace with the real AIUI voice/ASR API (see the AIUI Dev skill).
  // The glasses' native assistant uses "Hi Rokid" / STT. Below is a placeholder
  // that pulls text from whatever the AIUI runtime exposes.
  async captureAndAsk() {
    this.setData({ status: 'listening', answerText: '' })
    let text = ''
    try {
      // Example possibilities — pick the one your AIUI SDK exposes:
      //  text = await rokid.ai.speechToText()
      //  text = await this.getVoiceInput()
      //  text = await window.rokid?.asr?.listen()
      text = await this.getVoiceInput()   // <-- implement in the AIUI SDK
    } catch (e) {
      this.setData({ status: 'ready', answerText: '（取不了语音：' + (e && e.message || e) + '）' })
      return
    }
    await this.ask(text || '你好')
  },

  // implement voice capture with the AIUI speech API
  async getVoiceInput() {
    // AIUI speech: `SpeechRecognition` (simple) or `SpeechRecognitionSession`
    // (recorded/incremental audio via MediaRecorder). Verify the exact
    // start() signature, OR whether the spoken query already arrives via
    // onLoad(query) on semantic wake-up ("Hi Rokid, open the xxx agent").
    if (typeof SpeechRecognition !== 'undefined') {
      try {
        const rec = await SpeechRecognition.start({ lang: 'zh-CN' })
        return await new Promise((resolve) => {
          rec.onresult = (e) => resolve((e.results && e.results[e.resultIndex] && e.results[e.resultIndex][0] && e.results[e.resultIndex][0].transcript) || '')
          rec.onerror = () => resolve('')
          rec.onend = () => resolve('')
        })
      } catch (e) {
        // not available / non-interactive here
      }
    }
    return ''
  },

  // optional: capture a photo and send it with the query (vision)
  async askWithPhoto(text) {
    // TODO: use the AIUI camera API to get an image (data URL or http URL),
    // then call askByMessage with an extra image message.
    // For the Hermes B bridge the request body can carry:
    //   message: [{role:'user',type:'text',text}, {role:'user',type:'image',image_url}]
    await this.ask(text)
  },

  onKeyUp(event) {
    if (event.code === 'Backspace' || event.code === 'Escape') {
      this.stop()
      return
    }
    if (!this.data.focused && (event.code === 'Enter' || event.code === 'GlobalHook')) {
      this.setData({ focused: true })
      return
    }
    if (this.data.focused && event.code === 'Enter') {
      this.captureAndAsk()
      this.setData({ focused: false })
    }
  },

  onLoad() {
    // auto-grab the first utterance on open (like the Lingzhu "图片" one-shot)
    this.captureAndAsk()
  },
}
</script>

<page>
  <view class="container">
    <text class="title">Hermes · {{ status }}</text>
    <text class="answer">{{ answerText || '按一下输入，或直接对它说话' }}</text>
    <button class="{{ focused ? 'focused' : '' }}" bindtap="captureAndAsk">说话</button>
  </view>
</page>

<style>
.container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100vh;
}
.title {
  color: #40FF5E;
  width: 100%;
  text-align: center;
  font-size: 22px;
  margin-bottom: 16px;
}
.answer {
  color: #40FF5E;
  width: 88%;
  text-align: left;
  font-size: 18px;
  line-height: 24px;
  margin-bottom: 20px;
  white-space: pre-wrap;
}
button {
  color: #40FF5E;
  border: 1px solid #40ff5d42;
  border-radius: 12px;
  padding: 5px;
  width: 100px;
  line-height: 24px;
  text-align: center;
}
button.focused { border: 2px solid #40FF5E; }
</style>
