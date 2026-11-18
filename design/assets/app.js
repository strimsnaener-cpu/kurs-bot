document.querySelector('.burger')?.addEventListener('click', () => document.querySelector('.links').classList.toggle('open'));

const io = new IntersectionObserver(entries => entries.forEach(x => {
  if (x.isIntersecting) { x.target.classList.add('in'); io.unobserve(x.target); }
}), { threshold: .1 });
document.querySelectorAll('.reveal').forEach(el => io.observe(el));

document.querySelectorAll('.filters').forEach(f => f.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  f.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on');
  const c = b.dataset.f;
  document.querySelectorAll('[data-cat]').forEach(el => {
    el.style.display = (c === 'all' || el.dataset.cat.split(' ').includes(c)) ? '' : 'none';
  });
}));

document.querySelectorAll('.toggle').forEach(t => t.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  t.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on');
  document.querySelectorAll('[data-m]').forEach(p => p.textContent = b.dataset.i === 'y' ? p.dataset.y : p.dataset.m);
  document.querySelectorAll('.per').forEach(p => p.textContent = b.dataset.i === 'y' ? ' /year' : ' /month');
}));
