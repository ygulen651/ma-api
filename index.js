const express = require('express');
const cheerio = require('cheerio');
const chromium = require('@sparticuz/chromium');

// Vercel için puppeteer-core, local için puppeteer
let puppeteer;
if (process.env.VERCEL) {
  puppeteer = require('puppeteer-core');
} else {
  puppeteer = require('puppeteer');
}

const app = express();
const PORT = process.env.PORT || 3000;

// JSON middleware
app.use(express.json());

const FLASHSCORE_URL = 'https://www.flashscore.com.tr/takim/karaman-fk/vF0VBreO/fikstur/';

async function fetchKaramanFixture() {
  let browser;
  try {
    console.log('Tarayıcı başlatılıyor...');
    
    // Vercel için özel ayarlar
    const isVercel = process.env.VERCEL;
    
    let launchOptions;
    
    if (isVercel) {
      // Vercel için @sparticuz/chromium kullan
      // Chromium'un executable path'ini al
      const executablePath = await chromium.executablePath();
      console.log('Chromium executable path:', executablePath);
      
      launchOptions = {
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: executablePath,
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
      };
    } else {
      // Local development için normal ayarlar
      launchOptions = {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu'
        ]
      };
    }

    browser = await puppeteer.launch(launchOptions);

    const page = await browser.newPage();
    
    // User agent ayarla
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    console.log('Sayfa yükleniyor...');
    await page.goto(FLASHSCORE_URL, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Sayfanın tamamen yüklenmesi için biraz bekle
    await page.waitForTimeout(3000);

    // HTML içeriğini al
    const html = await page.content();
    await browser.close();

    const $ = cheerio.load(html);
    const matches = [];

    // Flashscore'un yeni yapısına göre selector'lar
    // event__match veya event__match--scheduled class'larını ara
    $('[class*="event__match"]').each((index, element) => {
      const $match = $(element);
      
      // Skor kontrolü
      const score = $match.find('[class*="event__score"]').text().trim();
      const hasScore = /\d+\s*[-–]\s*\d+/.test(score);

      // Sadece gelecek maçları al (skor yoksa)
      if (!hasScore) {
        // Tarih bilgisi
        let tarih = $match.find('[class*="event__time"]').first().text().trim();
        
        // Eğer tarih yoksa, parent container'dan al
        if (!tarih || tarih.length < 3) {
          const $parent = $match.closest('[class*="event__header"]');
          if ($parent.length) {
            tarih = $parent.find('[class*="event__time"]').text().trim();
          }
        }

        // Saat bilgisi
        let saat = $match.find('[class*="event__time"]').last().text().trim();
        
        // Tarih ve saat ayrıştırma
        if (tarih && /\d{2}:\d{2}/.test(tarih)) {
          const parts = tarih.split(' ');
          if (parts.length > 1) {
            tarih = parts.slice(0, -1).join(' ');
            saat = parts[parts.length - 1];
          } else {
            saat = tarih.match(/\d{2}:\d{2}/)?.[0] || '';
            tarih = tarih.replace(/\d{2}:\d{2}/, '').trim();
          }
        }

        // Takım isimleri - daha spesifik selector'lar
        let evSahibi = '';
        let deplasman = '';
        
        // Önce home/away class'larını dene
        const homeParticipant = $match.find('[class*="event__participant--home"], [class*="homeParticipant"], [class*="participant--home"]');
        const awayParticipant = $match.find('[class*="event__participant--away"], [class*="awayParticipant"], [class*="participant--away"]');
        
        if (homeParticipant.length > 0) {
          evSahibi = homeParticipant.first().text().trim();
        }
        if (awayParticipant.length > 0) {
          deplasman = awayParticipant.first().text().trim();
        }

        // Alternatif selector'lar - participant class'ları
        if (!evSahibi || !deplasman) {
          const participants = $match.find('[class*="participant"]').not('[class*="event__time"]').not('[class*="event__score"]');
          if (participants.length >= 2) {
            const homeText = $(participants[0]).text().trim();
            const awayText = $(participants[1]).text().trim();
            // Sadece farklı takımları al
            if (homeText && awayText && homeText !== awayText) {
              evSahibi = homeText;
              deplasman = awayText;
            }
          }
        }

        // Daha genel arama - sadece gerekirse
        if (!evSahibi || !deplasman || evSahibi === deplasman || evSahibi.trim() === deplasman.trim()) {
          // Takım isimlerini sıfırla eğer aynıysa
          if (evSahibi === deplasman || evSahibi.trim() === deplasman.trim()) {
            evSahibi = '';
            deplasman = '';
          }
          
          const allText = $match.text();
          const lines = allText.split('\n').map(l => l.trim()).filter(l => l.length > 2);
          
          const teamNames = [];
          
          for (const line of lines) {
            // Saat bul
            if (/\d{2}:\d{2}/.test(line) && !saat) {
              const timeMatch = line.match(/\d{2}:\d{2}/);
              if (timeMatch) saat = timeMatch[0];
            }
            // Tarih bul
            if (/\d{2}\.\d{2}\.\d{4}/.test(line) && !tarih) {
              const dateMatch = line.match(/\d{2}\.\d{2}\.\d{4}/);
              if (dateMatch) tarih = dateMatch[0];
            }
            // Takım isimleri bul (uzun metinler ve saat/tarih içermeyenler)
            // Ayrıca "Karaman FK", "Altınordu" gibi takım isimleri genelde 3+ karakter
            if (line.length >= 3 && 
                !/\d{2}:\d{2}/.test(line) && 
                !/\d{2}\.\d{2}\.\d{4}/.test(line) && 
                !/\d+\s*[-–]\s*\d+/.test(line) &&
                !line.toLowerCase().includes('stadyum') &&
                !line.toLowerCase().includes('deplasman') &&
                !line.toLowerCase().includes('ev sahibi')) {
              // Tekrar eden takım isimlerini filtrele (case-insensitive)
              const normalizedLine = line.trim();
              const isDuplicate = teamNames.some(t => t.trim().toLowerCase() === normalizedLine.toLowerCase());
              if (!isDuplicate) {
                teamNames.push(normalizedLine);
              }
            }
          }
          
          // İlk iki FARKLI takım ismini al (kesinlikle farklı olmalı)
          if (teamNames.length >= 2) {
            const team1 = teamNames[0].trim();
            const team2 = teamNames[1].trim();
            // Sadece gerçekten farklıysa ata
            if (team1 !== team2 && team1.toLowerCase() !== team2.toLowerCase()) {
              evSahibi = team1;
              deplasman = team2;
            }
          }
        }

        // Ev sahibi ve deplasman aynıysa veya eksikse maçı ekleme
        if (!evSahibi || !deplasman || evSahibi === deplasman || evSahibi.trim() === deplasman.trim()) {
          console.log('Geçersiz takım bilgisi atlandı:', { evSahibi, deplasman });
          return;
        }

        // Gerekli bilgiler varsa ekle
        if (saat && evSahibi && deplasman && evSahibi !== deplasman) {
          // Stadyum belirleme
          const stadyum = evSahibi.toUpperCase().includes('KARAMAN') 
            ? 'Yeni Karaman Stadyumu' 
            : 'Deplasman';

          // Ev sahibi ve deplasman farklı olmalı (zaten yukarıda kontrol edildi, burada tekrar kontrol gereksiz)

          // Duplikasyon kontrolü
          const isDuplicate = matches.some(m => 
            m.evSahibi === evSahibi && m.deplasman === deplasman && m.saat === saat
          );

          if (!isDuplicate) {
            matches.push({
              tarih: tarih || '',
              saat: saat,
              evSahibi: evSahibi,
              deplasman: deplasman,
              stadyum: stadyum
            });
          }
        }
      }
    });

    // Eğer hala maç bulunamadıysa, daha genel bir arama yap
    if (matches.length === 0) {
      console.log('Standart selector\'lar çalışmadı, genel arama yapılıyor...');
      
      // Tüm text içeriğini analiz et
      const bodyText = $('body').text();
      const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 2);
      
      let currentMatch = null;
      const seenTeams = new Set();
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Saat formatı bul
        if (/\d{2}:\d{2}/.test(line) && !/\d+\s*[-–]\s*\d+/.test(line)) {
          const timeMatch = line.match(/\d{2}:\d{2}/);
          if (timeMatch) {
            // Yeni maç başlangıcı - önceki maçı kontrol et ve ekle
            if (currentMatch && currentMatch.saat && currentMatch.evSahibi && currentMatch.deplasman) {
              // Aynı takım kontrolü
              if (currentMatch.evSahibi !== currentMatch.deplasman && 
                  currentMatch.evSahibi.trim() !== currentMatch.deplasman.trim() &&
                  currentMatch.evSahibi.toLowerCase() !== currentMatch.deplasman.toLowerCase()) {
                matches.push(currentMatch);
              }
            }
            currentMatch = {
              tarih: '',
              saat: timeMatch[0],
              evSahibi: '',
              deplasman: '',
              stadyum: ''
            };
            seenTeams.clear();
          }
        }
        
        // Tarih bul
        if (/\d{2}\.\d{2}\.\d{4}/.test(line) && currentMatch) {
          const dateMatch = line.match(/\d{2}\.\d{2}\.\d{4}/);
          if (dateMatch) currentMatch.tarih = dateMatch[0];
        }
        
        // Takım isimleri bul
        if (currentMatch && line.length >= 3 && 
            !/\d{2}:\d{2}/.test(line) && 
            !/\d{2}\.\d{2}\.\d{4}/.test(line) && 
            !/\d+\s*[-–]\s*\d+/.test(line) &&
            !line.toLowerCase().includes('stadyum') &&
            !line.toLowerCase().includes('deplasman') &&
            !line.toLowerCase().includes('ev sahibi')) {
          const normalizedLine = line.trim().toLowerCase();
          
          if (!currentMatch.evSahibi) {
            currentMatch.evSahibi = line.trim();
            seenTeams.add(normalizedLine);
          } else if (!seenTeams.has(normalizedLine) && !currentMatch.deplasman) {
            // Sadece farklı takımları al
            const currentHome = currentMatch.evSahibi.trim().toLowerCase();
            if (normalizedLine !== currentHome) {
              currentMatch.deplasman = line.trim();
              seenTeams.add(normalizedLine);
              currentMatch.stadyum = currentMatch.evSahibi.toUpperCase().includes('KARAMAN') 
                ? 'Yeni Karaman Stadyumu' 
                : 'Deplasman';
            }
          }
        }
      }
      
      // Son maçı ekle
      if (currentMatch && currentMatch.saat && currentMatch.evSahibi && currentMatch.deplasman) {
        // Aynı takım kontrolü
        if (currentMatch.evSahibi !== currentMatch.deplasman && 
            currentMatch.evSahibi.trim() !== currentMatch.deplasman.trim() &&
            currentMatch.evSahibi.toLowerCase() !== currentMatch.deplasman.toLowerCase()) {
          matches.push(currentMatch);
        }
      }
    }

    // Son kontrol: Tüm maçları filtrele - aynı takım olanları çıkar
    const filteredMatches = matches.filter(m => {
      const isValid = m.evSahibi && 
                     m.deplasman && 
                     m.evSahibi.trim() !== m.deplasman.trim() &&
                     m.evSahibi.toLowerCase() !== m.deplasman.toLowerCase();
      if (!isValid) {
        console.log('Filtreleme: Aynı takım maçı çıkarıldı:', { evSahibi: m.evSahibi, deplasman: m.deplasman });
      }
      return isValid;
    });

    return {
      success: true,
      count: filteredMatches.length,
      matches: filteredMatches
    };

  } catch (error) {
    console.error('Hata:', error.message);
    if (browser) {
      await browser.close();
    }
    throw error;
  }
}

// API Endpoints

// Ana endpoint - Karaman FK fikstürünü getir
app.get('/api/fikstur', async (req, res) => {
  try {
    console.log('Fikstür isteği alındı...');
    const result = await fetchKaramanFixture();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Sağlık kontrolü endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'API çalışıyor' });
});

// Ana sayfa
app.get('/', (req, res) => {
  res.json({
    message: 'Karaman FK Fikstür API',
    endpoints: {
      fikstur: '/api/fikstur',
      health: '/health'
    }
  });
});

// Vercel için export (serverless function)
if (process.env.VERCEL) {
  module.exports = app;
} else {
  // Local development için server başlat
  app.listen(PORT, () => {
    console.log(`API sunucusu http://localhost:${PORT} adresinde çalışıyor`);
    console.log(`Fikstür endpoint: http://localhost:${PORT}/api/fikstur`);
  });
}
