// Hour 4: converter shell wiring (local only, no real conversion).
const chips=[...document.querySelectorAll('.grid article')];
console.log('queue ready', chips.length);
document.querySelector('.panel button')?.addEventListener('click',()=>alert('File picker coming online next hour — shell only.'));
