import { Client } from '@xhayper/discord-rpc';
import throttle from 'lodash-es/throttle';
import type { ExtensionContext, StatusBarItem, Pseudoterminal } from 'vscode';
import { commands, EventEmitter, StatusBarAlignment, window, workspace, debug } from 'vscode';
import { activity } from './activity';
import { CLIENT_ID, CONFIG_KEYS } from './constants';
import { log, LogLevel } from './logger';
import { getConfig, getGit } from './util';

const statusBarIcon: StatusBarItem = window.createStatusBarItem(StatusBarAlignment.Left);
statusBarIcon.text = '$(pulse) Connecting to Discord...';

const PERSISTENCE_KEY = 'discordPresenceStartTimestamp';

let rpc = new Client({ transport: { type: 'ipc' }, clientId: CLIENT_ID });
const config = getConfig();

let state: Record<string, unknown> = {};
let idle: NodeJS.Timeout | undefined;
let listeners: { dispose(): any }[] = [];
let extensionContext: ExtensionContext | undefined;


export function cleanUp() {
	for (const listener of listeners) listener.dispose();
	listeners = [];
}

async function sendActivity() {
	// eslint-disable-next-line require-atomic-updates
	state = {
		...(await activity(state)),
	};

	void rpc.user?.setActivity(state);

	if (extensionContext) {
		void extensionContext.globalState.update(
			PERSISTENCE_KEY,
			typeof state.startTimestamp === 'number' ? state.startTimestamp : undefined,
		);
	}
}

function handleTerminalCommand(line: string) {
	const trimmed = line.trim();
	const match = trimmed.match(/^(?:setplaytime|discord\.setplaytime|discord\.setPlayTime)\s+(\d+)$/i);
	if (!match) return false;

	const seconds = Number(match[1]);
	state = { ...state, startTimestamp: Date.now() - seconds * 1_000 };
	if (extensionContext) {
		void extensionContext.globalState.update(PERSISTENCE_KEY, state.startTimestamp);
	}
	void sendActivity();
	void window.showInformationMessage(`Discord playtime set to ${seconds.toLocaleString()} seconds.`);
	return true;
}

function createDiscordTerminal() {
	const writeEmitter = new EventEmitter<string>();
	const closeEmitter = new EventEmitter<void>();
	let buffer = '';

	const prompt = () => writeEmitter.fire('> ');
	const writeLine = (line: string) => writeEmitter.fire(`${line}\r\n`);

	const pty: Pseudoterminal = {
		onDidWrite: writeEmitter.event,
		onDidClose: closeEmitter.event,
		open: () => {
			writeLine('Discord Playtime Terminal');
			writeLine('Type setplaytime <seconds> or exit');
			prompt();
		},
		close: () => {
			closeEmitter.fire();
		},
		handleInput: (data: string) => {
			for (const char of data) {
				if (char === '\r' || char === '\n') {
					writeEmitter.fire('\r\n');
					const line = buffer.trim();
					buffer = '';
					if (line.length === 0) {
						prompt();
						continue;
					}
					if (/^exit$/i.test(line) || /^quit$/i.test(line)) {
						writeLine('Closing Discord Playtime Terminal');
						closeEmitter.fire();
						return;
					}
					if (!handleTerminalCommand(line)) {
						writeLine(`Unknown command: ${line}`);
						writeLine('Use setplaytime <seconds> to update Discord time.');
					}
					prompt();
				} else if (char === '\u0008' || char === '\u007f') {
					buffer = buffer.slice(0, -1);
					writeEmitter.fire('\x08 \x08');
				} else {
					buffer += char;
					writeEmitter.fire(char);
				}
			}
		},
	};

	return window.createTerminal({ name: 'Discord Playtime', pty });
}

async function login() {
	log(LogLevel.Info, 'Creating discord-rpc client');
	rpc = new Client({ transport: { type: 'ipc' }, clientId: CLIENT_ID });

	rpc.on('ready', () => {
		log(LogLevel.Info, 'Successfully connected to Discord');
		cleanUp();

		statusBarIcon.text = '$(globe) Connected to Discord';
		statusBarIcon.tooltip = 'Connected to Discord';

		void sendActivity();
		const onChangeActiveTextEditor = window.onDidChangeActiveTextEditor(async () => sendActivity());
		const onChangeTextDocument = workspace.onDidChangeTextDocument(throttle(async () => sendActivity(), 2_000));
		const onStartDebugSession = debug.onDidStartDebugSession(async () => sendActivity());
		const onTerminateDebugSession = debug.onDidTerminateDebugSession(async () => sendActivity());

		listeners.push(onChangeActiveTextEditor, onChangeTextDocument, onStartDebugSession, onTerminateDebugSession);
	});

	rpc.on('disconnected', () => {
		cleanUp();
		void rpc.destroy();
		statusBarIcon.text = '$(pulse) Reconnect to Discord';
		statusBarIcon.command = 'discord.reconnect';
	});

	try {
		await rpc.login();
	} catch (error) {
		log(LogLevel.Error, `Encountered following error while trying to login:\n${error as string}`);
		cleanUp();
		void rpc.destroy();
		if (!config[CONFIG_KEYS.SuppressNotifications]) {
			// @ts-expect-error: error is not typed
			if (error?.message?.includes('ENOENT')) void window.showErrorMessage('No Discord client detected');
			else void window.showErrorMessage(`Couldn't connect to Discord via RPC: ${error as string}`);
		}

		statusBarIcon.text = '$(pulse) Reconnect to Discord';
		statusBarIcon.command = 'discord.reconnect';
	}
}

export async function activate(context: ExtensionContext) {
	extensionContext = context;
	console.log('===== DISCORD EXTENSION ACTIVATING =====');
	log(LogLevel.Info, 'Discord Presence activated');

	const previousStartTimestamp = context.globalState.get<number>(PERSISTENCE_KEY);
	if (typeof previousStartTimestamp === 'number') {
		state = { startTimestamp: previousStartTimestamp };
	}

	let isWorkspaceExcluded = false;
	for (const pattern of config[CONFIG_KEYS.WorkspaceExcludePatterns]) {
		const regex = new RegExp(pattern);
		const folders = workspace.workspaceFolders;
		if (!folders) break;
		if (folders.some((folder) => regex.test(folder.uri.fsPath))) {
			isWorkspaceExcluded = true;
			break;
		}
	}

	const enable = async (update = true) => {
		if (update) {
			try {
				await config.update('enabled', true);
			} catch {}
		}

		log(LogLevel.Info, 'Enable: Cleaning up old listeners');
		cleanUp();
		statusBarIcon.text = '$(pulse) Connecting to Discord...';
		statusBarIcon.show();
		log(LogLevel.Info, 'Enable: Attempting to recreate login');
		void login();
	};

	const disable = async (update = true) => {
		if (update) {
			try {
				await config.update('enabled', false);
			} catch {}
		}

		log(LogLevel.Info, 'Disable: Cleaning up old listeners');
		cleanUp();
		void rpc?.destroy();
		log(LogLevel.Info, 'Disable: Destroyed the rpc instance');
		statusBarIcon.hide();
	};

	const enabler = commands.registerCommand('discord.enable', async () => {
		await disable();
		await enable();
		await window.showInformationMessage('Enabled Discord Presence for this workspace');
	});

	const disabler = commands.registerCommand('discord.disable', async () => {
		await disable();
		await window.showInformationMessage('Disabled Discord Presence for this workspace');
	});

	const reconnecter = commands.registerCommand('discord.reconnect', async () => {
		await disable(false);
		await enable(false);
	});

	const disconnect = commands.registerCommand('discord.disconnect', async () => {
		await disable(false);
		statusBarIcon.text = '$(pulse) Reconnect to Discord';
		statusBarIcon.command = 'discord.reconnect';
		statusBarIcon.show();
	});

	const openPlaytimeTerminal = commands.registerCommand('discord.openPlaytimeTerminal', async () => {
		try {
			console.log('Opening Discord Playtime Terminal...');
			const terminal = createDiscordTerminal();
			terminal.show();
			console.log('Discord Playtime Terminal opened successfully');
		} catch (error) {
			console.error('Error opening Discord Playtime Terminal:', error);
			void window.showErrorMessage(`Failed to open playtime terminal: ${error}`);
		}
	});

	const setPlayTime = commands.registerCommand('discord.setPlayTime', async () => {
		const input = await window.showInputBox({
			prompt: 'Enter playtime in seconds',
			placeHolder: '120',
			validateInput: (value) => {
				const parsed = Number(value.trim());
				if (value.trim() === '') return 'Please enter a value.';
				if (!Number.isFinite(parsed) || parsed < 0) return 'Enter a non-negative number.';
				return null;
			},
		});

		if (!input) return;
		const seconds = Number(input.trim());
		if (!Number.isFinite(seconds) || seconds < 0) {
			void window.showErrorMessage('Invalid playtime value. Use a non-negative number.');
			return;
		}

		state = { ...state, startTimestamp: Date.now() - seconds * 1_000 };
		if (extensionContext) {
			void extensionContext.globalState.update(PERSISTENCE_KEY, state.startTimestamp);
		}
		await sendActivity();
		void window.showInformationMessage(`Discord playtime set to ${seconds.toLocaleString()} seconds.`);
	});

	context.subscriptions.push(enabler, disabler, reconnecter, disconnect, openPlaytimeTerminal, setPlayTime);
	console.log('All Discord commands registered successfully');
	console.log('Registered commands:', ['discord.enable', 'discord.disable', 'discord.reconnect', 'discord.disconnect', 'discord.openPlaytimeTerminal', 'discord.setPlayTime']);

	if (!isWorkspaceExcluded && config[CONFIG_KEYS.Enabled]) {
		statusBarIcon.show();
		await login();
	}

	window.onDidChangeWindowState(async (windowState) => {
		if (config[CONFIG_KEYS.IdleTimeout] !== 0) {
			if (windowState.focused) {
				if (idle) {
					// eslint-disable-next-line no-restricted-globals
					clearTimeout(idle);
				}

				await sendActivity();
			} else {
				// eslint-disable-next-line no-restricted-globals
				idle = setTimeout(async () => {
					// Update presence to an idle state but preserve the startTimestamp
					// so elapsed time continues to be tracked while VS Code is in background.
					await sendActivity();
				}, config[CONFIG_KEYS.IdleTimeout] * 1_000);
			}
		}
	});

	await getGit();
}

export function deactivate() {
	cleanUp();
	void rpc.destroy();
}
