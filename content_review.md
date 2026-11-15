# Content review

Everything listed here is shipped but worth a human look. Video metadata (title, channel, duration,
views, publish date) was fetched from YouTube with yt-dlp on 2026-11-15, and top comments were read
for every main and backup video. No links were invented.

Note: like counts from the localized YouTube page were unreliable, so selection used views, date and
top comments instead.

## Module 1 — status: 20/20 lessons ready, 39 videos verified, 0 unverified, 0 English-only

### Shorter than the 6-minute ideal (chosen because they are the best-received option)
| lesson | video | length | why kept |
|---|---|---|---|
| m1w1l1 | Haggon — «4 минуты и ты знаешь как устроен компьютер» | 4:20 | 3.7M views, comments say it beats months of school lessons; alt is 10:07 |
| m1w1l2 | Джонник — «Edu: Как работает компьютер» | 4:42 | 182k views; alt 5:08 |
| m1w2l4 | Просто о сложном — «Принцип работы КЭШ памяти» | 4:54 | uses the same chef analogy as the course; alt 8:31 |
| m1w4l2 | Vik Bil — «ВСЕ операционные системы за 5 минут» | 5:22 | overview; alt (Droider iOS vs Android) is 16:01 |
| m1w4l4 | CompShop — «6 минут и ты знаешь как включается компьютер» | 5:54 | see topic note below |

### Topic fit is partial
- **m1w4l4 «Как запускается приложение»**: no good beginner Russian video exists about app launch itself.
  The main video covers the boot process; the lesson card explains app launch (storage → RAM → process).
  The backup (Dr Bragin, processes and threads) is a more advanced lecture.

### Older videos (evergreen topic, still accurate)
- m1w4l5 main (file system, 2013) and m1w4l3 backup (drivers, 2013).
- m1w4l1 main (operating system, 2015).

### Ads or self-promotion in the video or pinned comment (judged safe)
- m1w3l3 backup (Droider GPU): sponsored segment for an electronics store.
- m1w4l4 main (CompShop): pinned comment links to the author's PC shop.
- m1w2l4 backup (Merion Academy): pinned comment advertises their own paid course.
- **Rejected on purpose:** «Что такое UEFI и BIOS» (pinned «discount on Windows keys») and Vik Bil «ВСЕ компоненты ПК»
  (pinned ggsel resale links). Neither is used.

### No backup video
- m1w3l2 (SSD/HDD): no second verified video of good quality was found.

### Facts to double-check
- m1w2l5: A18 Pro = 6-core CPU (2 performance + 4 efficiency), GPU, 16-core Neural Engine.
- m1w3l1: iPhone 16 Pro Max has 8 GB RAM.

## «На досуге» (content/library.json) — 20 items, all verified 2026-11-15
- **Required ИИздец videos:** found and verified.
  - «Я провёл в Claude Code 6000+ часов. Тут всё, что тебе нужно» (48:05, 56k views).
  - «Команда AI-агентов УПРАВЛЯЕТ БИЗНЕСОМ без меня» (30:06, 28k views).
- ⚠️ **Please decide:** other channels have published exposés claiming the ИИздец author sells paid
  Telegram channels and courses deceptively. Example: Гилт, «ИИздец / ТОМ КРОКОДИЛ … развод на доверии», 18k views,
  with commenters saying they lost money. The two videos are included as you asked, each with a visible warning:
  «ничего не покупай и не переводи деньги». To remove them, delete the two entries from `content/library.json`.
- **«ИИ заберёт работу в 2026» from the same creators:** not found on the ИИздец channel, so it was not added.
  The jobs category uses other well-received videos instead, for example the Глеб Соломин podcast with ex-Google X Mo Gawdat (1.26M views).
- **English items (flagged 🇬🇧 with a subtitles hint):** 2 videos by 3Blue1Brown.
- **Spotify / YouTube Music links:** none added, because none could be verified without a browser. The YouTube links work in the YouTube Music app too.
- **Rejected on purpose:**
  - Droider «Как на самом деле работает нейросеть»: a comment shows an online-casino ad inside the video.
  - Videos whose pinned comment is a sales funnel: «бесплатная AI-диагностика бизнеса» and a «заработал $… в 19 лет» Claude Code video.

## «Модели ИИ» (content/ai_models.json)
- **Age rules (checked 2026-11-15):**
  - Claude.ai consumer terms require **18+**.
  - ChatGPT is 13+ with parental consent.
  - Gemini teen rules vary by country.
  
  So the course tells the student to use **free ChatGPT or Gemini**, and Claude is described but not recommended.
- **Prices:** written as ranges ("about $8–20/month") so they don't go stale. No exact model versions are named.
