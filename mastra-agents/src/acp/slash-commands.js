export function getSlashCommands() {
    return [
        { name: '/agents', description: 'List available agents' },
        { name: '/status', description: 'Show session status' },
        { name: '/mode', description: 'Select mode' },
        { name: '/model', description: 'Select model' },
        { name: '/thinking', description: 'Select thinking level' },
    ];
}
