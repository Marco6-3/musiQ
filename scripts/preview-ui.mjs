// Development-only visual fixtures. No real accounts, music sources or database.
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const songs = ['晨间电台', '穿过城市的风', '这是一个用来检查极长歌曲标题是否被正确截断的测试曲目', '傍晚散步', '夜色与远方', '缓慢的星期天'].map((name, i) => ({
  id: `qa-${i}`, name, artist: ['界面测试音乐人'], album: i === 2 ? '很长很长的专辑名称用于检查窄屏中的文字溢出' : '视觉测试专辑', source: 'netease', duration: 30,
  cover_url: '/public/music-default.png'
}));
const wav = Buffer.alloc(44 + 44100 * 2 * 30);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(88200, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length-44, 40);
const server = await createServer({
  configFile: false, root: path.join(root, 'webroot'),
  server: { host: value('--host', '127.0.0.1'), port: Number(value('--port', '4173')), strictPort: true, allowedHosts: ['terminal.local'] },
  plugins: [{ name: 'music-visual-fixtures', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url, 'http://preview.test');
      const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
      if (url.pathname === '/__qa') {
        const width = Math.max(320, Math.min(1600, Number(url.searchParams.get('width')) || 1280));
        const height = Math.max(375, Math.min(1000, Number(url.searchParams.get('height')) || 800));
        res.setHeader('Content-Type','text/html');
        res.end(`<html><body style="margin:0;background:#09090b"><iframe title="Music visual test" src="/" style="display:block;width:${width}px;height:${height}px;border:0"></iframe></body></html>`); return;
      }
      if (url.pathname === '/__qa/silence.wav') { res.setHeader('Content-Type','audio/wav'); res.end(wav); return; }
      if (url.pathname === '/php/toplist.php') return json({success:true,data:songs});
      if (url.pathname === '/api.php') {
        if (url.searchParams.get('types') === 'url') return json({url:'/__qa/silence.wav',br:999,codec:'wav',verified_audio:true,lossless:true});
        if (url.searchParams.get('types') === 'lyric') return json({lyric:'[00:00.00]这是用于界面检查的占位文字\n[00:06.00]验证滚动位置与文字间距\n[00:12.00]测试播放界面与按钮布局'});
        if (url.searchParams.get('types') === 'pic') return json({url:'/public/music-default.png'});
        return json(url.searchParams.get('name') === 'empty' ? [] : songs);
      }
      if (url.pathname.startsWith('/api_check/')) return json({success:true,data:[],providers:{}});
      if (url.pathname.startsWith('/php/')) return json({success:false,message:'视觉测试环境不连接真实账号'});
      next();
    });
  }}]
});
await server.listen();
server.printUrls();
