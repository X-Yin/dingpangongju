const mermaid = require('mermaid');
mermaid.initialize({ startOnLoad: false });
const graph = `gantt
    title A Gantt Diagram
    dateFormat  YYYY-MM-DD
    section Section 1
    A task           :a1, 2014-01-01, 30d
    section Section 2
    Another task     :a2, 2014-01-20, 20d`;

async function run() {
    try {
        const { svg } = await mermaid.render('graphDiv', graph);
        console.log(svg);
    } catch (e) {
        console.error(e);
    }
}
run();
