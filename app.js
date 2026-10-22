const state = {
  data: null,
  progress: loadProgress(),
  user: null,
  supabase: null,
  accountMessage: '',
  filters: { topic: '全部知识板块', mastery: '全部掌握状态', search: '', ratings: { difficulty: false, importance: false, exam_probability: false } }
};
const masteryOptions = ['尚未评估', '我没有完全看懂', '我看懂了但无法复述', '我可以复述', '我完全掌握了'];
const revealLabels = [['problem', '题目'], ['hint', '大致思路'], ['framework', '思维推进框架'], ['solution', '完整答案'], ['reflection', '反思收获']];
const LAST_VIEWED_QUESTION_KEY = 'math-analysis-last-viewed-question';
const DEEPSEEK_KEY_STORAGE = 'math-analysis-deepseek-key-session';
let assistantFocusText = '';

function loadProgress() {
  try { return JSON.parse(localStorage.getItem('math-analysis-progress') || '{}'); }
  catch (_) { return {}; }
}
function progressStorageKey(user = state.user) {
  return user?.id ? `math-analysis-progress:${user.id}` : 'math-analysis-progress';
}
function loadScopedProgress(user = state.user) {
  try { return JSON.parse(localStorage.getItem(progressStorageKey(user)) || '{}'); }
  catch (_) { return {}; }
}
function masteryOf(q) { return state.progress[q.id] || q.default_mastery; }
function saveMastery(id, value) {
  state.progress[id] = value;
  try { localStorage.setItem(progressStorageKey(), JSON.stringify(state.progress)); }
  catch (_) { /* private browsing may disable storage; keep this session usable */ }
  if(state.supabase && state.user) {
    state.supabase.from('user_progress').upsert({user_id:state.user.id,question_id:id,mastery:value,updated_at:new Date().toISOString()},{onConflict:'user_id,question_id'})
      .then(({error})=>{ if(error) console.error('云端进度保存失败',error); });
  }
}
async function loadCloudProgress() {
  if(!state.supabase || !state.user) return;
  const userId=state.user.id;
  const {data,error}=await state.supabase.from('user_progress').select('question_id,mastery').eq('user_id',userId);
  if(error) { state.accountMessage='云端进度读取失败：'+error.message; return; }
  if(state.user?.id!==userId) return;
  state.progress=Object.fromEntries((data||[]).map(row=>[row.question_id,row.mastery]));
  try { localStorage.setItem(progressStorageKey(state.user),JSON.stringify(state.progress)); } catch (_) {}
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function stackSlashFractions(value) {
  const indexed='[A-Za-z0-9]+(?:_\\{[^{}]+\\}|_[A-Za-z0-9]+)?(?:\\^\\{[^{}]+\\}|\\^[A-Za-z0-9]+)?';
  const command='(?:\\\\sqrt(?:\\{[^{}]*\\}|[A-Za-z0-9])|\\\\(?:[A-Za-z]+(?:\\{[^{}]*\\}|\\s+\\{[^{}]*\\})?|\\\\))';
  const atom='(?:\\([^()]*\\)|'+command+'|'+indexed+')';
  // Do not begin matching in the middle of a TeX command (e.g. turn `\pm3/2`
  // into `\dfrac{pm3}{2}`). The numeric part may still be stacked normally.
  return value.replace(new RegExp('(?<![A-Za-z\\\\])('+atom+')\\s*/\\s*('+atom+')','g'),'\\dfrac{$1}{$2}');
}
function normalizeMathOperators(value) {
  // Backtick formulas are authored in lightweight notation (e.g. `ln n`,
  // `lim_{n→∞}`). Typeset standard function names as operators, not variables.
  return value
    .replace(/\\sqrt(?!\s*\{)([A-Za-z0-9])/g, (_, radicand) => `\\sqrt{${radicand}}`)
    .replace(/√([A-Za-z0-9])/g, (_, radicand) => `\\sqrt{${radicand}}`)
    .replace(/\\(pm|mp)([0-9]+)\/([0-9]+)/g, (_, sign, numerator, denominator) => `\\${sign}\\dfrac{${numerator}}{${denominator}}`)
    .replace(/\b(ln|log|sin|cos|tan|exp|arcsin|arccos|arctan)\s+([A-Za-z](?:_[A-Za-z0-9]+)?)/g,
      (_, operator, argument) => `\\${operator}{${argument}}`)
    .replace(/(?<!\\)\b(arcsin|arccos|arctan|limsup|liminf|ln|log|lim|sin|cos|tan|exp)\b/g,
      (_, operator) => `\\${operator}`);
}
function md(value) {
  let s = escapeHtml(value);
  s = s.replace(/^### (.+)$/gm, '<h4>$1</h4>').replace(/^## (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>.*<\/li>\n?)+/g, m => '<ul>'+m+'</ul>');
  s = s.replace(/^\s*\d+\.\s+(.+)$/gm, '<li>$1</li>');
  const tick=String.fromCharCode(96);
  s = s.replace(new RegExp(tick+'([^'+tick+']+)'+tick,'g'), (_, value) => {
    const looksLikeMath=/[\\_^{}=<>≤≥∈∀∃→↔∑∏∫√±×÷∞]/.test(value)||/^[A-Za-z](?:_[A-Za-z0-9]+)?$/.test(value);
    const formula=stackSlashFractions(normalizeMathOperators(value));
    const isMath=looksLikeMath||formula!==value;
    return isMath?'\\('+formula+'\\)':'<code>'+value+'</code>';
  });
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, value) => '<div class="math-box">\\['+stackSlashFractions(normalizeMathOperators(value))+'\\]</div>');
  s = s.replace(/\$([^$\n]+)\$/g, (_, value) => '\\('+stackSlashFractions(normalizeMathOperators(value))+'\\)');
  return s.split(/\n{2,}/).map(block => /^<(h[34]|ul|div)/.test(block.trim()) ? block : '<p>'+block.replace(/\n/g,'<br>')+'</p>').join('');
}
function stars(n) { return '<span class="stars" aria-label="'+n+'颗星">'+'★'.repeat(n)+'☆'.repeat(5-n)+'</span>'; }
function ratingRows(p) { const r=p.ratings; return '<div class="rating-row"><span>难度</span>'+stars(r.difficulty)+'</div><div class="rating-row"><span>重要性</span>'+stars(r.importance)+'</div><div class="rating-row"><span>复现概率（暂定）</span>'+stars(r.exam_probability)+'</div>'; }
function topicRoots() { return ['全部知识板块', ...new Set(state.data.questions.flatMap(q => q.knowledge.map(k => k.split('/')[0])))]; }
function questionSummary(q) {
  // Keep the complete problem statement in cards and the detail header, including
  // a target expression that may live in its own paragraph.
  return md(q.sections.problem.replace(/\s+/g, ' ').trim());
}
function compactSearch(value) {
  return String(value ?? '').toLowerCase().replace(/[\s，。、“”‘’：:；;、/\\_\-]+/g, '');
}
function searchAliases(q) {
  return [
    q.id,
    'w'+String(q.week).padStart(2,'0')+'q'+String(q.question_number).padStart(2,'0'),
    '第'+q.week+'周第'+q.question_number+'题',
    '第'+q.week+'周 第'+q.question_number+'题',
    q.week+'-'+q.question_number,
    q.week+'/'+q.question_number
  ];
}
function matchesSearch(q, query) {
  const needle=compactSearch(query);
  if(!needle) return true;
  const haystack=compactSearch([q.title, q.search_text, ...q.knowledge, ...q.tags, ...searchAliases(q)].join(' '));
  return haystack.includes(needle);
}
function matches(q) {
  const f=state.filters;
  return (f.topic==='全部知识板块'||q.knowledge.some(k=>k.startsWith(f.topic+'/'))) &&
    (f.mastery==='全部掌握状态'||masteryOf(q)===f.mastery) &&
    matchesSearch(q, f.search) &&
    (!f.ratings.difficulty||q.ratings.difficulty<=3) &&
    (!f.ratings.importance||q.ratings.importance>=4) &&
    (!f.ratings.exam_probability||q.ratings.exam_probability>=4);
}
function problemCard(q) {
  return '<article class="problem-card card"><a class="problem-link" href="#problem/'+q.id+'"><div class="problem-title">第'+q.week+'周 · 第'+q.question_number+'题 · '+escapeHtml(q.title)+'</div><div class="problem-summary">'+questionSummary(q)+'</div><div class="problem-meta"><span class="week-tag">第'+q.week+'周</span>'+q.knowledge.slice(0,2).map(k=>'<span class="tag">'+escapeHtml(k.split('/').at(-1))+'</span>').join('')+'<span class="mastery-tag">'+escapeHtml(masteryOf(q))+'</span></div></a><div class="rating-stack"><div>难度 '+stars(q.ratings.difficulty)+'</div><div>重要性 '+stars(q.ratings.importance)+'</div><div>复现 '+stars(q.ratings.exam_probability)+'</div></div></article>';
}
function header(title, subtitle) { return '<div class="eyebrow">数学分析·题库 by paperlover</div><h1>'+title+'</h1><p class="hero-copy p">'+subtitle+'</p>'; }
function homeView() {
  const qs=state.data.questions, lastId=(()=>{try{return localStorage.getItem(LAST_VIEWED_QUESTION_KEY)}catch(_){return null}})(), featured=qs.find(q=>q.id===lastId)||qs.find(q=>q.id==='w02-q11')||qs[0], hasLastViewed=featured.id===lastId, mastered=qs.filter(q=>masteryOf(q)==='我完全掌握了').length, assessed=qs.filter(q=>masteryOf(q)!=='尚未评估').length, progress=Math.round(mastered/qs.length*100);
  return '<div id="home"><section class="hero"><div class="hero-copy">'+header('今天你杜分析了吗','学完杜分析可以拿八百万年薪量化大结果吗qwq')+'</div><div class="progress-card"><div class="progress-top"><span>题库进度</span><span>'+assessed+'/'+qs.length+' 已标记</span></div><div class="progress-number">'+progress+'% 完全掌握</div><div class="progress-track"><div class="progress-fill" style="width:'+progress+'%"></div></div></div></section><section class="section"><div class="section-head"><div><h2>继续学习</h2><p>'+(hasLastViewed?'接着上次浏览的题目继续学习':'还记得这道题吗？')+'</p></div><a class="small-button" href="#library">查看全部题目 →</a></div><div class="continue-grid"><a class="continue-card featured card" href="#problem/'+featured.id+'"><div><div class="card-meta"><span>第'+featured.week+'周 · 第'+featured.question_number+'题</span><span>'+(hasLastViewed?'上次浏览':'推荐')+'</span></div><div class="card-title">'+escapeHtml(featured.title)+'</div><div class="card-description">'+questionSummary(featured)+'</div></div><div class="card-bottom"><span class="status-pill">'+escapeHtml(masteryOf(featured))+'</span><span class="mini-arrow">↗</span></div></a></div></section><section class="section"><div class="section-head"><div><h2>从这里开始</h2><p>四种进入方式</p></div></div><div class="tool-grid"><a class="tool-card card" href="#random"><div class="tool-icon">⌁</div><h3>just do it！</h3><p>从前三级掌握状态中随机抽一道题。</p></a><a class="tool-card card" href="#library"><div class="tool-icon">⌘</div><h3>按知识找题</h3><p>按三级知识路径查找完整题目。</p></a><a class="tool-card card" href="#library?ratings=need"><div class="tool-icon">↻</div><h3>按需要练习</h3><p>按掌握程度与三维星级筛选。</p></a><a class="tool-card card" href="#review"><div class="tool-icon">✦</div><h3>我的复习</h3><p>集中查看前两级掌握状态的题目。</p></a></div></section><section class="section"><div class="card" style="padding:20px"><div class="library-top"><span class="week-tag">已接入</span><span class="muted" style="font-size:13px">'+qs.length+' 道题 · '+state.data.knowledge_index.length+' 条三级知识路径</span></div></div></section></div>';
}
function libraryView() {
  const shown=state.data.questions.filter(matches), topics=topicRoots();
  return '<div id="library">'+header('题库','我们已经做了这么多题了咩？？！！')+'<div class="library-layout section"><aside class="filters card"><h3>筛选题目</h3><div class="filter-group"><label class="filter-label">知识板块</label><select id="topic-filter" class="filter-select">'+topics.map(o=>'<option '+(o===state.filters.topic?'selected':'')+'>'+escapeHtml(o)+'</option>').join('')+'</select></div><div class="filter-group"><label class="filter-label">掌握程度</label><select id="mastery-filter" class="filter-select"><option>全部掌握状态</option>'+masteryOptions.map(o=>'<option '+(o===state.filters.mastery?'selected':'')+'>'+o+'</option>').join('')+'</select></div><div class="filter-group"><span class="filter-label">三维评级</span><label class="check-item"><input type="checkbox" data-rating="importance" '+(state.filters.ratings.importance?'checked':'')+'> 重要性 ≥ 4 星</label><label class="check-item"><input type="checkbox" data-rating="exam_probability" '+(state.filters.ratings.exam_probability?'checked':'')+'> 复现概率 ≥ 4 星</label><label class="check-item"><input type="checkbox" data-rating="difficulty" '+(state.filters.ratings.difficulty?'checked':'')+'> 难度 ≤ 3 星</label></div></aside><section><div class="library-top"><input id="search-input" class="search-input" aria-label="搜索题库" placeholder="如：第1周第2题、ε-N、极限定义" value="'+escapeHtml(state.filters.search)+'"><span class="result-count">显示 '+shown.length+' / '+state.data.questions.length+' 道题</span></div><div id="problem-results" class="problem-list">'+(shown.length?shown.map(problemCard).join(''):'<div class="card empty-state">没有符合筛选条件的题目。<br><br><button class="small-button" id="clear-filters">清除筛选</button></div>')+'</div></section></div></div>';
}
function updateLibraryResults() {
  const list=document.getElementById('problem-results');
  const count=document.querySelector('.result-count');
  if(!list||!count) return;
  const shown=state.data.questions.filter(matches);
  list.innerHTML=shown.length?shown.map(problemCard).join(''):'<div class="card empty-state">没有符合筛选条件的题目。<br><br><button class="small-button" id="clear-filters">清除筛选</button></div>';
  if(window.MathJax?.typesetPromise) window.MathJax.typesetPromise([list]).catch(error=>console.error('数学公式排版失败',error));
  count.textContent='显示 '+shown.length+' / '+state.data.questions.length+' 道题';
  document.getElementById('clear-filters')?.addEventListener('click',()=>{state.filters={topic:'全部知识板块',mastery:'全部掌握状态',search:'',ratings:{difficulty:false,importance:false,exam_probability:false}};render()});
}
function detailView(id) {
  const q=state.data.questions.find(x=>x.id===id)||state.data.questions[0];
  const body=revealLabels.map(([key,label],i)=>'<details class="reveal" '+(i===0?'open':'')+'><summary><span class="reveal-index">0'+(i+1)+'</span>'+label+'</summary><div class="reveal-body markdown">'+md(q.sections[key])+'</div></details>').join('');
  return '<div id="detail"><a class="back" href="#library">← 返回题库</a><div class="detail-header"><div class="detail-main"><div class="eyebrow">第'+q.week+'周 · 第'+q.question_number+'题 · '+escapeHtml(q.knowledge[0].split('/')[0])+'</div><h1 class="detail-title">'+escapeHtml(q.title)+'</h1><div class="detail-subtitle">'+questionSummary(q)+'</div><div class="detail-tags">'+q.tags.map(t=>'<span class="tag">'+escapeHtml(t)+'</span>').join('')+'</div></div><aside class="detail-ratings card">'+ratingRows(q)+'</aside></div><div class="study-layout"><section class="study-column">'+body+'<section class="assistant-card card" id="study-assistant"><div class="assistant-heading"><div><span class="eyebrow">DEEPSEEK · BYOK</span><h2>这一步卡住了吗？</h2><p>助手会读取本题全部内容，包括尚未展开的部分。</p></div><span class="assistant-mark">✳</span></div><details class="assistant-key-settings"><summary>设置 DeepSeek API Key</summary><div class="assistant-key-row"><input id="deepseek-key" type="password" autocomplete="off" placeholder="粘贴你的 DeepSeek API Key"><button class="small-button" id="save-deepseek-key" type="button">本次会话使用</button><button class="text-button" id="clear-deepseek-key" type="button">清除</button></div><p class="assistant-privacy">密钥只保存在当前标签页会话中，关闭标签页后清除；不会写入题库或网站代码。提问时题目内容和问题会发送给 DeepSeek API。</p><div class="assistant-key-status" id="deepseek-key-status"></div></details><div class="assistant-focus"><label for="assistant-focus-text">聚焦内容（可选）</label><div class="assistant-focus-row"><textarea id="assistant-focus-text" rows="2" placeholder="选中答案里想问的文字，再点“引用选中文字”；也可以直接粘贴公式或句子。"></textarea><button class="small-button" id="capture-assistant-focus" type="button">引用选中文字</button></div></div><div class="assistant-chat" id="assistant-chat" aria-live="polite"><div class="assistant-empty">例如：“为什么这里可以用 Stolz 定理？”或“请把这一步展开说明。”</div></div><form class="assistant-compose" id="assistant-form"><textarea id="assistant-question" rows="2" required placeholder="告诉我你卡在哪一步…"></textarea><button class="small-button primary-button" type="submit">提问 ↗</button></form><div class="assistant-notice" id="assistant-notice" role="status"></div></section></section><aside><div class="side-card card"><h3>我的状态</h3><select class="mastery-select" id="detail-mastery">'+masteryOptions.map(o=>'<option '+(o===masteryOf(q)?'selected':'')+'>'+o+'</option>').join('')+'</select><div class="save-note">状态已按题目保存到本机浏览器。</div></div><div class="side-card card"><h3>知识点位置</h3>'+q.knowledge.map(k=>'<div class="side-row"><span>'+escapeHtml(k)+'</span></div>').join('')+'</div><div class="side-card card"><h3>来源与核对</h3><div class="side-row"><span>资料</span><b>'+escapeHtml(q.sources.join('；'))+'</b></div><div class="side-row"><span>页码</span><b>'+escapeHtml(q.source_pages)+'</b></div></aside></div></div>';
}
function reviewView() {
  const qs=state.data.questions.filter(q=>masteryOf(q)==='我没有完全看懂'||masteryOf(q)==='我看懂了但无法复述');
  return '<div>'+header('我的复习','只显示掌握程度停留在前两级的题目。')+'<section class="section"><div class="problem-list">'+(qs.length?qs.map(problemCard).join(''):'<div class="card empty-state">当前没有前两级掌握状态的题目。</div>')+'</div></section></div>';
}
function accountView() {
  const user=state.user;
  if(user) return '<div>'+header('账号与同步','当前登录：'+escapeHtml(user.email||'')+'。掌握状态会同步到你的 Supabase 账号。')+'<section class="section card account-card"><p>'+escapeHtml(state.accountMessage||'云端进度同步已连接。')+'</p><button class="small-button" id="sign-out">退出登录</button></section></div>';
  return '<div>'+header('登录与同步','登录后，你标记的掌握程度会保存到云端，并可在其他设备继续复习。')+'<section class="section card account-card"><form id="auth-form"><label for="auth-email">邮箱</label><input id="auth-email" type="email" autocomplete="email" required placeholder="name@example.com"><label for="auth-password">密码</label><input id="auth-password" type="password" autocomplete="current-password" minlength="6" required placeholder="至少 6 位"><div class="account-actions"><button class="small-button primary-button" type="submit" data-auth-action="signin">登录</button><button class="small-button" type="button" id="sign-up">创建账号</button><button class="text-button" type="button" id="reset-password">忘记密码</button></div></form><p class="account-message" id="account-message">'+escapeHtml(state.accountMessage||'')+'</p></section></div>';
}
function bindAccount() {
  const form=document.getElementById('auth-form');
  const message=document.getElementById('account-message');
  const say=text=>{state.accountMessage=text;if(message)message.textContent=text};
  document.getElementById('sign-out')?.addEventListener('click',async()=>{const {error}=await state.supabase.auth.signOut();if(error)say(error.message);else{state.user=null;state.accountMessage='已退出登录。';render()}});
  if(!form) return;
  const email=()=>document.getElementById('auth-email').value.trim();
  const password=()=>document.getElementById('auth-password').value;
  form.addEventListener('submit',async e=>{e.preventDefault();say('正在登录…');const {error}=await state.supabase.auth.signInWithPassword({email:email(),password:password()});say(error?'登录失败：'+error.message:'登录成功，正在同步进度…')});
  document.getElementById('sign-up').onclick=async()=>{say('正在创建账号…');const {data,error}=await state.supabase.auth.signUp({email:email(),password:password(),options:{emailRedirectTo:location.origin+location.pathname+'#account'}});say(error?'注册失败：'+error.message:(data.session?'账号已创建并登录。':'注册请求已提交。请查收邮箱并点击确认链接，再返回本网站登录。'))};
  document.getElementById('reset-password').onclick=async()=>{if(!email()){say('请先填写邮箱，再点击忘记密码。');return}const {error}=await state.supabase.auth.resetPasswordForEmail(email(),{redirectTo:location.origin+location.pathname+'#account'});say(error?'发送失败：'+error.message:'如果该邮箱已注册，密码重置邮件很快会送达。')};
}
function bindLibrary() {
  document.getElementById('topic-filter').onchange=e=>{state.filters.topic=e.target.value;render()};
  document.getElementById('mastery-filter').onchange=e=>{state.filters.mastery=e.target.value;render()};
  const input=document.getElementById('search-input');
  input.oninput=e=>{state.filters.search=e.target.value;updateLibraryResults()};
  input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();state.filters.search=input.value.trim();updateLibraryResults()}};
  document.querySelectorAll('[data-rating]').forEach(el=>el.onchange=e=>{state.filters.ratings[e.target.dataset.rating]=e.target.checked;render()});
  document.getElementById('clear-filters')?.addEventListener('click',()=>{state.filters={topic:'全部知识板块',mastery:'全部掌握状态',search:'',ratings:{difficulty:false,importance:false,exam_probability:false}};render()});
}
function bindDetail() {
  const select=document.getElementById('detail-mastery');
  const id=location.hash.slice(1).split('?')[0].slice(8);
  if(select) select.onchange=e=>{ saveMastery(id,e.target.value); };
  const keyInput=document.getElementById('deepseek-key');
  const keyStatus=document.getElementById('deepseek-key-status');
  const savedKey=()=>{try{return sessionStorage.getItem(DEEPSEEK_KEY_STORAGE)||''}catch(_){return ''}};
  if(keyInput && savedKey()) keyInput.value=savedKey();
  const setKeyStatus=message=>{if(keyStatus)keyStatus.textContent=message};
  document.getElementById('save-deepseek-key')?.addEventListener('click',()=>{
    const key=keyInput?.value.trim();
    if(!key){setKeyStatus('请先粘贴 DeepSeek API Key。');return}
    try{sessionStorage.setItem(DEEPSEEK_KEY_STORAGE,key);setKeyStatus('已保存到当前标签页会话。')}
    catch(_){setKeyStatus('浏览器阻止了会话存储，请检查隐私设置后重试。')}
  });
  document.getElementById('clear-deepseek-key')?.addEventListener('click',()=>{
    try{sessionStorage.removeItem(DEEPSEEK_KEY_STORAGE)}catch(_){}
    if(keyInput)keyInput.value='';setKeyStatus('已清除当前标签页中的密钥。');
  });
  document.getElementById('capture-assistant-focus')?.addEventListener('click',()=>{
    const selected=window.getSelection()?.toString().trim();
    const focus=document.getElementById('assistant-focus-text');
    if(selected){focus.value=selected;assistantFocusText=selected;document.getElementById('assistant-notice').textContent='已引用选中文字。'}
    else document.getElementById('assistant-notice').textContent='请先在题目或答案中选中一段文字，再点击此按钮。';
  });
  const form=document.getElementById('assistant-form');
  const chat=document.getElementById('assistant-chat');
  const notice=document.getElementById('assistant-notice');
  const focusInput=document.getElementById('assistant-focus-text');
  focusInput?.addEventListener('input',()=>{assistantFocusText=focusInput.value});
  form?.addEventListener('submit',async event=>{
    event.preventDefault();
    const key=savedKey()||keyInput?.value.trim();
    const question=document.getElementById('assistant-question').value.trim();
    if(!key){setKeyStatus('请先设置 API Key，再提问。');document.querySelector('.assistant-key-settings')?.setAttribute('open','');return}
    if(!question)return;
    const q=state.data.questions.find(item=>item.id===id);
    if(!q){notice.textContent='找不到当前题目，请返回题库后重试。';return}
    const sections=revealLabels.map(([field,label])=>'【'+label+'】\n'+(q.sections?.[field]||'（该部分暂无内容）')).join('\n\n');
    const context='题目：'+q.title+'\n位置：第'+q.week+'周第'+q.question_number+'题\n知识点：'+(q.knowledge||[]).join('；')+'\n\n'+sections;
    const focus=focusInput?.value.trim()||assistantFocusText;
    const send=document.querySelector('#assistant-form button[type="submit"]');
    const append=(role,text)=>{const item=document.createElement('div');item.className='assistant-message '+role;item.textContent=text;chat.append(item);chat.scrollTop=chat.scrollHeight;return item};
    chat.querySelector('.assistant-empty')?.remove();
    append('user',question+(focus?'\n聚焦内容：'+focus:''));
    const pending=append('assistant','正在向 DeepSeek 提问…');
    send.disabled=true;notice.textContent='';
    try{
      const response=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify({model:'deepseek-chat',temperature:0.3,messages:[
        {role:'system',content:'你是复旦大学数学分析课程的耐心助教。请用中文帮助学生理解解答中难懂的部分。先指出核心逻辑，再逐步解释关键定义、定理条件和推导；必要时给一个小例子。围绕用户的问题和聚焦内容回答，不要无端重写整题；如果题解可能有误，明确指出并解释。数学公式用 LaTeX。'},
        {role:'user',content:'下面是当前题目的完整资料（包括尚未在页面展开的部分），请作为回答上下文：\n\n'+context+'\n\n'+(focus?'用户特别聚焦的原文：\n'+focus+'\n\n':'')+'用户的问题：\n'+question}
      ]})});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.error?.message||('HTTP '+response.status));
      const answer=data.choices?.[0]?.message?.content;
      if(!answer)throw new Error('接口没有返回回答内容。');
      pending.textContent=answer;
    }catch(error){
      pending.textContent='请求失败：'+error.message+'。如果是浏览器网络/CORS 错误，当前静态网页可能无法直接连接 API；可检查密钥和网络，或后续改用仅供个人部署的代理服务。';
    }finally{send.disabled=false;document.getElementById('assistant-question').value='';}
  });
}
function openSearch() {
  if(!location.hash.startsWith('#library')) location.hash='#library';
  const focus=()=>document.getElementById('search-input')?.focus();
  focus();
  setTimeout(focus,50);
}
document.addEventListener('click',e=>{
  if(e.target.closest('#search-trigger')) { e.preventDefault(); openSearch(); }
  if(e.target.closest('#account-trigger')) { e.preventDefault(); location.hash='#account'; }
});
function updateNav(route) {
  const section=route.startsWith('problem/') ? 'library' : (route || 'home');
  document.querySelectorAll('[data-nav]').forEach(link=>{
    const active=link.dataset.nav===section;
    link.classList.toggle('active',active);
    if(active) link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  });
}
function render() {
  if(!state.data){document.getElementById('app').innerHTML='<div class="section"><div class="card" style="padding:24px">正在加载完整题库…</div></div>';return}
  const raw=location.hash.slice(1)||'home', [route,query]=raw.split('?');
  updateNav(route);
  if(route==='library' && query){
    const params=new URLSearchParams(query);
    if(params.has('search')) state.filters.search=params.get('search')||'';
    if(params.has('mastery')) state.filters.mastery=params.get('mastery')||'全部掌握状态';
  }
  if(route==='random'){const c=state.data.questions.filter(q=>masteryOf(q)!=='我完全掌握了');location.hash='problem/'+c[Math.floor(Math.random()*c.length)].id;return}
  const app=document.getElementById('app');
  if(window.MathJax?.typesetClear) window.MathJax.typesetClear([app]);
  if(route.startsWith('problem/')){const questionId=route.slice(8);if(state.data.questions.some(q=>q.id===questionId)){try{localStorage.setItem(LAST_VIEWED_QUESTION_KEY,questionId)}catch(_){/* browsing history is optional */}}app.innerHTML=detailView(questionId);bindDetail()}
  else if(route==='library'){if(query?.includes('ratings=need'))state.filters.ratings={difficulty:false,importance:true,exam_probability:true};app.innerHTML=libraryView();bindLibrary()}
  else if(route==='review')app.innerHTML=reviewView();
  else if(route==='account'){app.innerHTML=accountView();bindAccount()}
  else app.innerHTML=homeView();
  if(window.MathJax?.typesetPromise) window.MathJax.typesetPromise([app]).catch(error=>console.error('数学公式排版失败',error));
  window.scrollTo({top:0,behavior:'instant'});
}
window.addEventListener('hashchange',render);
if(window.supabase?.createClient && window.SUPABASE_CONFIG?.url && window.SUPABASE_CONFIG?.publishableKey) {
  state.supabase=window.supabase.createClient(window.SUPABASE_CONFIG.url,window.SUPABASE_CONFIG.publishableKey);
  state.supabase.auth.getSession().then(async({data,error})=>{
    if(error) console.error('登录状态读取失败',error);
    state.user=data?.session?.user||null;
    state.progress=loadScopedProgress();
    await loadCloudProgress();
    render();
  });
  state.supabase.auth.onAuthStateChange((_event,session)=>{
    state.user=session?.user||null;
    state.progress=loadScopedProgress();
    if(state.user) state.accountMessage='已登录，正在同步进度…';
    render();
    if(state.user) setTimeout(()=>loadCloudProgress().then(()=>{state.accountMessage='云端进度同步完成。';render()}),0);
  });
} else {
  state.accountMessage='登录服务未初始化。请检查 supabase-config.js 是否配置正确，以及网络能否加载 Supabase 客户端。';
}
fetch('library.json').then(r=>{if(!r.ok)throw Error('题库文件加载失败');return r.json()}).then(data=>{state.data=data;render()}).catch(err=>{document.getElementById('app').innerHTML='<div class="section"><div class="card" style="padding:24px">无法加载内容库。请确认 library.json 与 index.html 位于同一目录，或通过本地服务器打开此网页；不要直接使用 file://。</div></div>';console.error(err)});

