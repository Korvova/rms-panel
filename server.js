const express = require('express');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const xml2js = require('xml2js');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const multer = require('multer');

// Устанавливаем московский часовой пояс
process.env.TZ = 'Europe/Moscow';

const app = express();
const PORT = 8085;

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'public', 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const roomId = req.params.id || 'temp';
        cb(null, `bg_${roomId}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (extname && mimetype) {
            cb(null, true);
        } else {
            cb(new Error('Только изображения (jpeg, jpg, png, gif, webp)'));
        }
    }
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Путь к файлу с данными комнат
const ROOMS_FILE = path.join(__dirname, 'data', 'rooms.json');

// Создаём папку data если нет
if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
}

// Загрузка комнат
function loadRooms() {
    try {
        if (fs.existsSync(ROOMS_FILE)) {
            return JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Ошибка загрузки rooms.json:', e);
    }
    return {};
}

// Сохранение комнат
function saveRooms(rooms) {
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2));
}

// Получение IP адресов сервера
function getServerIPs() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push(iface.address);
            }
        }
    }
    return ips;
}

// Парсинг iCalendar данных
function parseICalendar(icalData) {
    const events = [];
    const lines = icalData.split('\n');
    let currentEvent = null;

    for (let line of lines) {
        line = line.trim();

        if (line === 'BEGIN:VEVENT') {
            currentEvent = {};
        } else if (line === 'END:VEVENT' && currentEvent) {
            events.push(currentEvent);
            currentEvent = null;
        } else if (currentEvent) {
            if (line.startsWith('SUMMARY:')) {
                currentEvent.name = line.substring(8);
            } else if (line.startsWith('DTSTART')) {
                const value = line.split(':').pop();
                currentEvent.dateFrom = parseICalDate(value);
            } else if (line.startsWith('DTEND')) {
                const value = line.split(':').pop();
                currentEvent.dateTo = parseICalDate(value);
            } else if (line.startsWith('ORGANIZER')) {
                const match = line.match(/CN=([^;:]+)/);
                if (match) {
                    currentEvent.organizer = match[1];
                }
            } else if (line.startsWith('DESCRIPTION:')) {
                currentEvent.description = line.substring(12);
            }
        }
    }

    return events;
}

// Парсинг даты iCalendar
function parseICalDate(dateStr) {
    // Формат: 20231225T100000Z или 20231225T100000
    if (dateStr.length >= 15) {
        const year = dateStr.substring(0, 4);
        const month = dateStr.substring(4, 6);
        const day = dateStr.substring(6, 8);
        const hour = dateStr.substring(9, 11);
        const minute = dateStr.substring(11, 13);
        const second = dateStr.substring(13, 15);

        const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
        if (dateStr.endsWith('Z')) {
            // UTC время - конвертируем в локальное
            return date;
        }
        return date;
    }
    return new Date(dateStr);
}

// Получение событий из CalDAV
async function fetchCalDAVEvents(caldavUrl, username, password) {
    try {
        const auth = Buffer.from(`${username}:${password}`).toString('base64');

        // Определяем даты для запроса (сегодня)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Сначала пробуем простой GET запрос (для публичных .ics)
        if (caldavUrl.endsWith('.ics')) {
            const response = await fetch(caldavUrl, {
                headers: {
                    'Authorization': `Basic ${auth}`
                }
            });

            if (response.ok) {
                const icalData = await response.text();
                const allEvents = parseICalendar(icalData);

                // Фильтруем события на сегодня
                return allEvents.filter(event => {
                    if (!event.dateFrom) return false;
                    const eventDate = new Date(event.dateFrom);
                    return eventDate >= today && eventDate < tomorrow;
                });
            }
        }

        // CalDAV REPORT запрос
        const reportBody = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${today.toISOString().replace(/[-:]/g, '').split('.')[0]}Z"
                      end="${tomorrow.toISOString().replace(/[-:]/g, '').split('.')[0]}Z"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

        const response = await fetch(caldavUrl, {
            method: 'REPORT',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/xml',
                'Depth': '1'
            },
            body: reportBody
        });

        if (!response.ok) {
            console.error('CalDAV error:', response.status, await response.text());
            return [];
        }

        const xmlData = await response.text();
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(xmlData);

        const events = [];
        // Парсим ответ CalDAV
        const responses = result['D:multistatus']?.['D:response'] ||
                         result['d:multistatus']?.['d:response'] ||
                         result['multistatus']?.['response'] || [];

        for (const resp of responses) {
            const propstat = resp['D:propstat'] || resp['d:propstat'] || resp['propstat'];
            if (propstat) {
                const prop = propstat[0]?.['D:prop'] || propstat[0]?.['d:prop'] || propstat[0]?.['prop'];
                const calData = prop?.[0]?.['C:calendar-data'] || prop?.[0]?.['cal:calendar-data'] || prop?.[0]?.['calendar-data'];
                if (calData) {
                    const icalStr = Array.isArray(calData) ? calData[0] : calData;
                    const parsed = parseICalendar(typeof icalStr === 'string' ? icalStr : icalStr._);
                    events.push(...parsed);
                }
            }
        }

        return events;
    } catch (error) {
        console.error('Ошибка получения CalDAV:', error);
        return [];
    }
}

// ============== API ==============

// Получить все комнаты
app.get('/api/rooms', (req, res) => {
    const rooms = loadRooms();
    const ips = getServerIPs();
    res.json({ rooms, serverIPs: ips, port: PORT });
});

// Добавить комнату
app.post('/api/rooms', (req, res) => {
    const { name, caldavUrl, username, password } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Название комнаты обязательно' });
    }

    const rooms = loadRooms();
    const id = uuidv4().substring(0, 8);

    rooms[id] = {
        id,
        name,
        caldavUrl: caldavUrl || '',
        username: username || '',
        password: password || '',
        createdAt: new Date().toISOString()
    };

    saveRooms(rooms);
    res.json({ success: true, room: rooms[id] });
});

// Обновить комнату
app.put('/api/rooms/:id', (req, res) => {
    const { id } = req.params;
    const { name, caldavUrl, username, password } = req.body;

    const rooms = loadRooms();

    if (!rooms[id]) {
        return res.status(404).json({ error: 'Комната не найдена' });
    }

    rooms[id] = {
        ...rooms[id],
        name: name || rooms[id].name,
        caldavUrl: caldavUrl !== undefined ? caldavUrl : rooms[id].caldavUrl,
        username: username !== undefined ? username : rooms[id].username,
        password: password !== undefined ? password : rooms[id].password
    };

    saveRooms(rooms);
    res.json({ success: true, room: rooms[id] });
});

// Удалить комнату
app.delete('/api/rooms/:id', (req, res) => {
    const { id } = req.params;
    const rooms = loadRooms();

    if (!rooms[id]) {
        return res.status(404).json({ error: 'Комната не найдена' });
    }

    // Удаляем фоновую картинку если есть
    if (rooms[id].background) {
        const bgPath = path.join(__dirname, 'public', rooms[id].background);
        if (fs.existsSync(bgPath)) {
            fs.unlinkSync(bgPath);
        }
    }

    delete rooms[id];
    saveRooms(rooms);
    res.json({ success: true });
});

// Загрузить фоновую картинку для комнаты
app.post('/api/rooms/:id/background', upload.single('background'), (req, res) => {
    const { id } = req.params;
    const rooms = loadRooms();

    if (!rooms[id]) {
        return res.status(404).json({ error: 'Комната не найдена' });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'Файл не загружен' });
    }

    // Удаляем старый фон если есть
    if (rooms[id].background) {
        const oldPath = path.join(__dirname, 'public', rooms[id].background);
        if (fs.existsSync(oldPath)) {
            fs.unlinkSync(oldPath);
        }
    }

    rooms[id].background = `/uploads/${req.file.filename}`;
    saveRooms(rooms);

    res.json({ success: true, background: rooms[id].background });
});

// Удалить фоновую картинку комнаты
app.delete('/api/rooms/:id/background', (req, res) => {
    const { id } = req.params;
    const rooms = loadRooms();

    if (!rooms[id]) {
        return res.status(404).json({ error: 'Комната не найдена' });
    }

    if (rooms[id].background) {
        const bgPath = path.join(__dirname, 'public', rooms[id].background);
        if (fs.existsSync(bgPath)) {
            fs.unlinkSync(bgPath);
        }
        delete rooms[id].background;
        saveRooms(rooms);
    }

    res.json({ success: true });
});

// Получить события комнаты
app.get('/api/rooms/:id/events', async (req, res) => {
    const { id } = req.params;
    const rooms = loadRooms();

    if (!rooms[id]) {
        return res.status(404).json({ error: 'Комната не найдена' });
    }

    const room = rooms[id];

    if (!room.caldavUrl) {
        return res.json({ events: [], currentEvent: null, isFree: true });
    }

    const events = await fetchCalDAVEvents(room.caldavUrl, room.username, room.password);

    // Сортируем по времени
    events.sort((a, b) => new Date(a.dateFrom) - new Date(b.dateFrom));

    // Определяем текущее событие
    const now = new Date();
    let currentEvent = null;

    for (const event of events) {
        const start = new Date(event.dateFrom);
        const end = new Date(event.dateTo);
        if (now >= start && now < end) {
            currentEvent = event;
            break;
        }
    }

    res.json({
        events,
        currentEvent,
        isFree: currentEvent === null
    });
});

// ============== Страницы комнат ==============

// Страница комнаты по ID
app.get('/room/:id', async (req, res) => {
    const { id } = req.params;
    const rooms = loadRooms();

    if (!rooms[id]) {
        return res.status(404).send('Комната не найдена');
    }

    const room = rooms[id];
    let events = [];
    let currentEvent = null;
    let isFree = true;

    if (room.caldavUrl) {
        events = await fetchCalDAVEvents(room.caldavUrl, room.username, room.password);
        events.sort((a, b) => new Date(a.dateFrom) - new Date(b.dateFrom));

        const now = new Date();
        for (const event of events) {
            const start = new Date(event.dateFrom);
            const end = new Date(event.dateTo);
            if (now >= start && now < end) {
                currentEvent = event;
                isFree = false;
                break;
            }
        }
    }

    // Проверяем rmspanel параметр
    const desiredParam = isFree ? 'green' : 'red';
    const currentParam = req.query.rmspanel;

    if (currentParam !== desiredParam) {
        return res.redirect(`/room/${id}?rmspanel=${desiredParam}`);
    }

    // Отправляем HTML
    res.send(generateRoomHTML(room, events, currentEvent, isFree));
});

// Генерация HTML страницы комнаты
function generateRoomHTML(room, events, currentEvent, isFree) {
    const eventsHTML = events.map(event => {
        const startTime = new Date(event.dateFrom).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const endTime = new Date(event.dateTo).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const now = new Date();
        const isCurrent = currentEvent && event.dateFrom === currentEvent.dateFrom;
        return `
            <li class="${isCurrent ? 'current' : ''}">
                <span class="time">${startTime} – ${endTime}${isCurrent ? ' (сейчас)' : ''}</span>
                <span class="name">${escapeHtml(event.name || 'Событие')}</span>
            </li>
        `;
    }).join('');

    let remainingMinutes = 0;
    if (currentEvent) {
        remainingMinutes = Math.floor((new Date(currentEvent.dateTo) - new Date()) / 60000);
    }

    // Находим ближайшее событие (после текущего времени)
    const now = new Date();
    let nextEvent = null;
    for (const event of events) {
        const start = new Date(event.dateFrom);
        if (start > now) {
            nextEvent = event;
            break;
        }
    }

    // Определяем что показывать в футере
    let footerContent = null;
    if (!isFree && currentEvent) {
        // Занято - показываем название текущего события
        footerContent = escapeHtml(currentEvent.name || 'Событие');
    } else if (isFree && nextEvent) {
        // Свободно и есть ближайшее - показываем его
        const nextTime = new Date(nextEvent.dateFrom).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        footerContent = `Следующее: ${escapeHtml(nextEvent.name || 'Событие')} в ${nextTime}`;
    }
    // Если нет событий - footerContent остаётся null и футер не показываем

    // Фоновая картинка
    const backgroundStyle = room.background
        ? `background: url('${room.background}') center center / cover no-repeat;`
        : `background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);`;

    return `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Переговорная «${escapeHtml(room.name)}»</title>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: 'Roboto', sans-serif;
            ${backgroundStyle}
            min-height: 100vh;
            color: #fff;
            display: flex;
            flex-direction: column;
        }
        .glass {
            backdrop-filter: blur(10px);
            background: rgba(255, 255, 255, 0.1);
            box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
            padding: 20px;
            border-radius: 15px;
            margin: 10px;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .header h1 {
            font-size: 1.8rem;
        }
        #clock {
            font-size: 2rem;
            font-weight: 500;
        }
        .main {
            display: flex;
            flex: 1;
            gap: 15px;
            padding: 15px;
        }
        .current-event {
            flex: 1;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            position: relative;
            margin: 15vh 10px;
            backdrop-filter: blur(5px);
        }
        .current-event.free {
            background: rgba(0, 239, 64, 0.35);
        }
        .current-event.free h2 {
            font-size: 5rem;
            margin: 0;
        }
        .current-event.booked {
            background: rgba(255, 0, 0, 0.35);
        }
        .current-event.booked h2 {
            font-size: 5rem;
            margin: 0;
        }
        .current-event .event-name {
            font-size: 2rem;
            text-align: center;
            margin: 10px 0 0 0;
        }
        .current-event .details {
            position: absolute;
            bottom: 15px;
            left: 15px;
            font-size: 1.1rem;
            text-align: left;
        }
        .current-event .details p {
            margin: 2px 0;
        }
        .schedule {
            flex: 1;
            display: flex;
            flex-direction: column;
            max-width: 300px;
            background: rgba(24, 22, 22, 0.5);
            backdrop-filter: blur(10px);
        }
        .schedule h2 {
            margin-bottom: 15px;
            font-size: 1.5rem;
        }
        .schedule ul {
            list-style: none;
            max-height: 500px;
            overflow-y: auto;
        }
        .schedule li {
            padding: 12px;
            margin-bottom: 8px;
            border-radius: 10px;
            background: rgba(255, 255, 255, 0.1);
            display: flex;
            flex-direction: column;
            gap: 5px;
        }
        .schedule li.current {
            background: rgba(220, 53, 69, 0.4);
            border-left: 4px solid #dc3545;
        }
        .schedule li .time {
            font-size: 0.9rem;
            opacity: 0.8;
        }
        .schedule li .name {
            font-weight: 500;
        }
        .footer {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 20px;
            background: rgba(24, 22, 22, 0.5);
            backdrop-filter: blur(10px);
        }
        @media (max-width: 768px) {
            .main {
                flex-direction: column;
            }
            .schedule {
                max-width: 100%;
            }
            .current-event h2 {
                font-size: 2.5rem;
            }
        }
    </style>
</head>
<body>
    <div class="glass header">
        <h1>Переговорная «${escapeHtml(room.name)}»</h1>
        <div id="clock">--:--:--</div>
    </div>

    <div class="main">
        <div class="glass current-event ${isFree ? 'free' : 'booked'}">
            ${isFree ? `
                <h2>Свободно</h2>
            ` : `
                <h2>Занято</h2>
                <div class="event-name">${escapeHtml(currentEvent?.name || 'Событие')}</div>
                <div class="details">
                    ${currentEvent?.organizer ? `<p>Организатор: ${escapeHtml(currentEvent.organizer)}</p>` : ''}
                    <p>Время: ${formatTime(currentEvent?.dateFrom)} - ${formatTime(currentEvent?.dateTo)}</p>
                    <p id="remaining">До окончания: ${remainingMinutes} мин.</p>
                </div>
            `}
        </div>

        <div class="glass schedule">
            <h2>Расписание на сегодня</h2>
            <ul>
                ${eventsHTML || '<li>Нет событий</li>'}
            </ul>
        </div>
    </div>

    ${footerContent ? `
    <div class="glass footer">
        <span>${footerContent}</span>
    </div>
    ` : ''}

    <script>
        function updateClock() {
            const clock = document.getElementById('clock');
            const now = new Date();
            clock.textContent = now.toLocaleTimeString('ru-RU', {hour: '2-digit', minute:'2-digit', second:'2-digit'});
        }
        setInterval(updateClock, 1000);
        updateClock();

        // Обновление страницы каждые 30 секунд
        setTimeout(function(){
            window.location.reload();
        }, 30000);
    </script>
</body>
</html>`;
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatTime(dateStr) {
    if (!dateStr) return '--:--';
    return new Date(dateStr).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

// Админка
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Главная страница
app.get('/', (req, res) => {
    res.redirect('/admin');
});

app.listen(PORT, '0.0.0.0', () => {
    const ips = getServerIPs();
    console.log('');
    console.log('╔════════════════════════════════════════════╗');
    console.log('║     RMS Panel Server запущен!              ║');
    console.log('╠════════════════════════════════════════════╣');
    console.log(`║  Админка: http://localhost:${PORT}/admin`);
    console.log('║');
    ips.forEach(ip => {
        console.log(`║  По сети: http://${ip}:${PORT}/admin`);
    });
    console.log('╚════════════════════════════════════════════╝');
    console.log('');
});
