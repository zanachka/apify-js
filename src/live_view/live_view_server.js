import * as http from 'http';
import * as fs from 'fs-extra';
import * as path from 'path';
import { promisify } from 'util';
import * as express from 'express';
import * as socketio from 'socket.io';
import { promisifyServerListen } from '@apify/utilities';
import { ENV_VARS, LOCAL_ENV_VARS } from '@apify/consts';
import { Page } from 'puppeteer'; // eslint-disable-line no-unused-vars
import { addTimeoutToPromise } from '../utils';
import Snapshot from './snapshot';
import defaultLog from '../utils_log';

const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);
const ensureDir = promisify(fs.ensureDir);

const LOCAL_STORAGE_DIR = process.env[ENV_VARS.LOCAL_STORAGE_DIR] || '';
const DEFAULT_SCREENSHOT_DIR_PATH = path.resolve(LOCAL_STORAGE_DIR, 'live_view');

/**
 * `LiveViewServer` enables serving of browser snapshots via web sockets. It includes its own client
 * that provides a simple frontend to viewing the captured snapshots. A snapshot consists of three
 * pieces of information, the currently opened URL, the content of the page (HTML) and its screenshot.
 *
 * ```json
 * {
 *     "pageUrl": "https://www.example.com",
 *     "htmlContent": "<html><body> ....",
 *     "screenshotIndex": 3,
 *     "createdAt": "2019-04-18T11:50:40.060Z"
 * }
 * ```
 *
 * `LiveViewServer` is useful when you want to be able to inspect the current browser status on demand.
 * When no client is connected, the webserver consumes very low resources so it should have a close
 * to zero impact on performance. Only once a client connects the server will start serving snapshots.
 * Once no longer needed, it can be disabled again in the client to remove any performance impact.
 *
 * NOTE: Screenshot taking in browser typically takes around 300ms. So having the `LiveViewServer`
 * always serve snapshots will have a significant impact on performance.
 *
 * When using {@link PuppeteerPool}, the `LiveViewServer` can be
 * easily used just by providing the `useLiveView = true` option to the {@link PuppeteerPool}.
 * It can also be initiated via {@link PuppeteerCrawler} `puppeteerPoolOptions`.
 *
 * It will take snapshots of the first page of the latest browser. Taking snapshots of only a
 * single page improves performance and stability dramatically in high concurrency situations.
 *
 * When running locally, it is often best to use a headful browser for debugging, since it provides
 * a better view into the browser, including DevTools, but `LiveViewServer` works too.
 * @deprecated no longer supported, will be removed in 2.0
 * @ignore
 */
class LiveViewServer {
    /**
     * @param {Object} [options]
     *   All `LiveViewServer` parameters are passed
     *   via an options object with the following keys:
     * @param {string} [options.screenshotDirectoryPath]
     *   By default, the screenshots are saved to
     *   the `live_view` directory in the Apify local storage directory.
     *   Provide a different absolute path to change the settings.
     * @param {number} [options.maxScreenshotFiles=10]
     *   Limits the number of screenshots stored
     *   by the server. This is to prevent using up too much disk space.
     * @param {number} [options.snapshotTimeoutSecs=3]
     *   If a snapshot is not made within the timeout,
     *   its creation will be aborted. This is to prevent
     *   pages from being hung up by a stalled screenshot.
     * @param {number} [options.maxSnapshotFrequencySecs=2]
     *   Use this parameter to further decrease the resource consumption
     *   of `LiveViewServer` by limiting the frequency at which it'll
     *   serve snapshots.
     */
    constructor(options = {}) {
        const {
            screenshotDirectoryPath = DEFAULT_SCREENSHOT_DIR_PATH,
            maxScreenshotFiles = 10,
            snapshotTimeoutSecs = 3,
            maxSnapshotFrequencySecs = 2,
        } = options;

        this.log = defaultLog.child({ prefix: 'LiveViewServer' });
        this.screenshotDirectoryPath = screenshotDirectoryPath;
        this.maxScreenshotFiles = maxScreenshotFiles;
        this.snapshotTimeoutMillis = snapshotTimeoutSecs * 1000;
        this.maxSnapshotFrequencyMillis = maxSnapshotFrequencySecs * 1000;

        /**
         * @type {?Snapshot}
         * @private
         */
        this.lastSnapshot = null;
        this.lastScreenshotIndex = 0;

        // Server
        this.clientCount = 0;
        this._isRunning = false;
        this.httpServer = null;
        this.socketio = null;
        this.servingSnapshot = false;

        this._setupHttpServer();
    }

    /**
     * Starts the HTTP server with web socket connections enabled.
     * Snapshots will not be created until a client has connected.
     * @return {Promise<void>}
     */
    async start() {
        this._isRunning = true;
        try {
            await ensureDir(this.screenshotDirectoryPath);
            await promisifyServerListen(this.httpServer)(this.port);
            this.log.info('Live view web server started', { publicUrl: this.liveViewUrl });
        } catch (err) {
            this.log.exception(err, 'Live view web server failed to start.');
            this._isRunning = false;
        }
    }

    /**
     * Prevents the server from receiving more connections. Existing connections
     * will not be terminated, but the server will not prevent a process exit.
     * @return {Promise<void>}
     */
    async stop() {
        this.httpServer.unref();
        return new Promise((resolve) => {
            this.httpServer.close((err) => {
                this._isRunning = false;
                if (err) this.log.exception(err, 'Live view web server could not be stopped.');
                else this.log.info('Live view web server stopped.');
                resolve();
            });
        });
    }

    /**
     * Serves a snapshot to all connected clients.
     * Screenshots are not served directly, only their index number
     * which is used by client to retrieve the screenshot.
     *
     * Will time out and throw in `options.snapshotTimeoutSecs`.
     *
     * @param {Page} page
     * @return {Promise<void>}
     */
    async serve(page) {
        if (!this.hasClients()) return;
        // Only serve one snapshot at a time because Puppeteer
        // can't make screenshots in parallel.
        if (this.servingSnapshot) return;

        if (this.lastSnapshot) {
            if (this.lastSnapshot.age() < this.maxSnapshotFrequencyMillis) return;
        }

        try {
            this.servingSnapshot = true;
            const snapshot = await addTimeoutToPromise(
                this._makeSnapshot(page),
                this.snapshotTimeoutMillis,
                'LiveViewServer: Serving of Live View timed out.',
            );
            this._pushSnapshot(snapshot);
        } finally {
            this.servingSnapshot = false;
        }
    }

    /**
     * @return {boolean}
     */
    isRunning() {
        return this._isRunning;
    }

    /**
     * @return {boolean}
     */
    hasClients() {
        // Treat LiveViewServer as a client, until at least one snapshot is made.
        return this.lastSnapshot ? this.clientCount > 0 : true;
    }

    /**
     * Returns an absolute path to the screenshot with the given index.
     * @param {number} screenshotIndex
     * @return {string}
     * @ignore
     * @protected
     * @internal
     */
    _getScreenshotPath(screenshotIndex) {
        return path.join(this.screenshotDirectoryPath, `${screenshotIndex}.jpeg`);
    }

    /**
     * @param {Page} page
     * @return {Promise<Snapshot>}
     * @ignore
     * @protected
     * @internal
     */
    async _makeSnapshot(page) {
        const pageUrl = page.url();
        this.log.info('Making live view snapshot.', { pageUrl });
        const [htmlContent, screenshot] = await Promise.all([
            page.content(),
            page.screenshot({
                type: 'jpeg',
                quality: 75,
            }),
        ]);

        const screenshotIndex = this.lastScreenshotIndex++;

        await writeFile(this._getScreenshotPath(screenshotIndex), screenshot);
        if (screenshotIndex > this.maxScreenshotFiles - 1) {
            this._deleteScreenshot(screenshotIndex - this.maxScreenshotFiles);
        }

        const snapshot = new Snapshot({ pageUrl, htmlContent, screenshotIndex });
        this.lastSnapshot = snapshot;
        return snapshot;
    }

    /**
     * @param {Snapshot} snapshot
     * @ignore
     * @protected
     * @internal
     */
    _pushSnapshot(snapshot) {
        // Send new snapshot to clients
        this.log.debug('Sending live view snapshot', { createdAt: snapshot.createdAt, pageUrl: snapshot.pageUrl });
        this.socketio.emit('snapshot', snapshot);
    }

    /**
     * Initiates an async delete and does not wait for it to complete.
     * @param {number} screenshotIndex
     * @ignore
     * @protected
     * @internal
     */
    _deleteScreenshot(screenshotIndex) {
        unlink(this._getScreenshotPath(screenshotIndex))
            .catch((err) => this.log.exception(err, 'Cannot delete live view screenshot.'));
    }

    /**
     * @ignore
     * @protected
     * @internal
     */
    _setupHttpServer() {
        const containerPort = process.env[ENV_VARS.CONTAINER_PORT] || LOCAL_ENV_VARS[ENV_VARS.CONTAINER_PORT];

        this.port = parseInt(containerPort, 10);
        if (!(this.port >= 0 && this.port <= 65535)) {
            throw new Error('Cannot start LiveViewServer - invalid port specified by the '
                + `${ENV_VARS.CONTAINER_PORT} environment variable (was "${containerPort}").`);
        }
        this.liveViewUrl = process.env[ENV_VARS.CONTAINER_URL] || LOCAL_ENV_VARS[ENV_VARS.CONTAINER_URL];

        this.httpServer = http.createServer();
        const app = express();

        app.use('/', express.static(__dirname));

        // Serves JPEG with the last screenshot
        app.get('/screenshot/:index', (req, res) => {
            const screenshotIndex = req.params.index;
            const filePath = this._getScreenshotPath(screenshotIndex);
            res.sendFile(filePath);
        });

        app.all('*', (req, res) => {
            res.status(404).send('Nothing here');
        });

        this.httpServer.on('request', app);

        // Socket.io server used to send snapshots to client
        this.socketio = socketio(this.httpServer);
        this.socketio.on('connection', this._socketConnectionHandler.bind(this));
    }

    /**
     * @param {socketio.Socket} socket
     * @ignore
     * @protected
     * @internal
     */
    _socketConnectionHandler(socket) {
        this.clientCount++;
        this.log.info('Live view client connected', { clientId: socket.id });
        socket.on('disconnect', (reason) => {
            this.clientCount--;
            this.log.info('Live view client disconnected', { clientId: socket.id, reason });
        });
        socket.on('getLastSnapshot', () => {
            if (this.lastSnapshot) {
                this.log.debug('Sending live view snapshot', { createdAt: this.lastSnapshot.createdAt, pageUrl: this.lastSnapshot.pageUrl });
                this.socketio.emit('snapshot', this.lastSnapshot);
            }
        });
    }
}

export default LiveViewServer;
