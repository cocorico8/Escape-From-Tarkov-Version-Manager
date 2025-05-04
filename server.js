require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const fetch = require('node-fetch');
const zlib = require('zlib');
const fs = require('fs');
const morgan = require('morgan');
const winston = require('winston');
const rateLimit = require('express-rate-limit');
const DailyRotateFile = require('winston-daily-rotate-file');

// Configure logger
const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level.toUpperCase()}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new DailyRotateFile({
            filename: 'logs/application-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '30d'
        })
    ]
});

if (!fs.existsSync(path.join(__dirname, 'logs'))) {
    fs.mkdirSync(path.join(__dirname, 'logs'));
}

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    handler: (req, res) => {
        logger.warn(`Rate limit exceeded for IP: ${req.ip}`);
        res.status(429).json({
            err: 429,
            errmsg: 'Too many requests, please try again later'
        });
    }
});

const app = express();
app.use(morgan(':method :url :status :res[content-length] - :response-time ms', {
    stream: { write: m => logger.debug(m.trim()) }
}));
app.use(cors());
app.use(limiter);

// Configuration
const BEARER_TOKEN = process.env.BEARER_TOKEN;
const CACHE_TTL = process.env.CACHE_TTL || 300000;
const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, 'cache.json');
const CLIENT_DIR = path.join(__dirname, './');

if (!BEARER_TOKEN) {
    logger.error('BEARER_TOKEN environment variable is required');
    process.exit(1);
}

let apiCache = new Map();

function loadCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = fs.readFileSync(CACHE_FILE, 'utf8');
            const cacheData = JSON.parse(data);
            let validEntries = 0;

            cacheData.forEach(({ path, data, timestamp }) => {
                const isValid = path.startsWith('thirdparty_') ?
                    isValidForPath(path, data) :
                    (data?.err === 0 && isValidForPath(path, data));

                if (isValid && typeof timestamp === 'number') {
                    apiCache.set(path, { data, timestamp });
                    validEntries++;
                } else {
                    logger.warn(`Invalid cache entry for ${path}`);
                }
            });

            logger.info(`Loaded ${validEntries}/${cacheData.length} valid cache entries`);
        }
    } catch (err) {
        logger.error(`Cache load error: ${err.message}`);
    }
}

function pruneInvalidCache() {
    const initialSize = apiCache.size;

    Array.from(apiCache.entries()).forEach(([path, entry]) => {
        const isValid = path.startsWith('thirdparty_') ?
            isValidForPath(path, entry.data) :
            (isValidForPath(path, entry.data) && entry.data.err === 0);

        if (!isValid) {
            apiCache.delete(path);
        }
    });

    if (initialSize !== apiCache.size) {
        logger.warn(`Pruned ${initialSize - apiCache.size} invalid cache entries`);
        saveCache();
    }
}

function isValidForPath(apiPath, data) {
    if (apiPath.startsWith('thirdparty_')) {
        return !!data?.SourceClientVersion && Array.isArray(data?.Mirrors);
    }

    switch (apiPath) {
        case 'configuration':
            return !!data?.data?.channels?.instances;
        case 'game-updates/eft':
            return Array.isArray(data?.data);
        case 'game-installation/eft':
            return !!data?.data?.downloadUri;
        default:
            return false;
    }
}

function saveCache() {
    try {
        const cacheArray = Array.from(apiCache.entries())
            .filter(([path, entry]) => {
                if (path.startsWith('thirdparty_')) {
                    return isValidForPath(path, entry.data);
                }
                return entry.data?.err === 0 && isValidForPath(path, entry.data);
            })
            .map(([path, entry]) => ({
                path,
                data: entry.data,
                timestamp: entry.timestamp
            }));

        fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheArray, null, 2));
        logger.debug(`Saved ${cacheArray.length} validated cache entries`);
    } catch (err) {
        logger.error(`Cache save error: ${err.message}`);
    }
}

function sanitizeConfig(originalData) {
    if (!originalData?.data?.channels) {
        return {
            ...originalData,
            err: originalData?.err || 1,
            errmsg: originalData?.errmsg || 'Invalid configuration response',
            data: null
        };
    }

    return {
        ...originalData,
        data: {
            channels: {
                instances: originalData.data.channels.instances
            }
        }
    };
}

function sanitizeGameUpdates(originalData) {
    if (!Array.isArray(originalData?.data)) {
        return {
            ...originalData,
            err: originalData?.err || 1,
            errmsg: originalData?.errmsg || 'Invalid game updates response',
            data: null
        };
    }

    return {
        ...originalData,
        data: originalData.data.map(update => ({
            version: update.version,
            fromVersion: update.fromVersion,
            hash: update.hash,
            downloadUri: update.downloadUri
        }))
    };
}

function sanitizeGameInstallation(originalData) {
    if (!originalData?.data?.downloadUri) {
        return {
            ...originalData,
            err: originalData?.err || 1,
            errmsg: originalData?.errmsg || 'Invalid installation response',
            data: null
        };
    }

    return {
        ...originalData,
        data: {
            version: originalData.data.version,
            hash: originalData.data.hash,
            downloadUri: originalData.data.downloadUri,
            requiredFreeSpace: originalData.data.requiredFreeSpace
        }
    };
}

process.on('unhandledRejection', (err) => {
    logger.error(`Unhandled Promise Rejection: ${err.message}`);
});

process.on('uncaughtException', (err) => {
    logger.error(`Uncaught Exception: ${err.message}`);
    process.exit(1);
});

async function fetchExternalApi(apiPath, isThirdParty = false) {
    const now = Date.now();
    const cacheKey = isThirdParty ? `thirdparty_${apiPath}` : apiPath;
    const cacheEntry = apiCache.get(cacheKey);

    if (cacheEntry && (now - cacheEntry.timestamp) < CACHE_TTL) {
        logger.debug(`Cache hit for ${cacheKey} (age: ${Math.round((now - cacheEntry.timestamp)/1000)}s)`);
        return cacheEntry.data;
    }

    try {
        logger.info(`Fetching ${cacheKey}`);
        const url = isThirdParty ? apiPath : `https://launcher.escapefromtarkov.com/launcher/${apiPath}`;
        
        const response = await fetch(url, {
            headers: isThirdParty ? {} : { Authorization: `Bearer ${BEARER_TOKEN}` }
        });

        let data;
        if (isThirdParty) {
            data = await response.json();
        } else {
            const buffer = await response.buffer();
            data = JSON.parse(zlib.inflateSync(buffer).toString());
        }

        if (data?.err === 201 || data?.err === 401) {
            throw new Error(`Authorization failed (${data.err})`);
        }

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        let sanitized = data;
        if (!isThirdParty) {
            switch (apiPath) {
                case 'configuration':
                    sanitized = sanitizeConfig(data);
                    break;
                case 'game-updates/eft':
                    sanitized = sanitizeGameUpdates(data);
                    break;
                case 'game-installation/eft':
                    sanitized = sanitizeGameInstallation(data);
                    break;
            }
        }

        apiCache.set(cacheKey, { data: sanitized, timestamp: now });
        saveCache();
        return sanitized;

    } catch (error) {
        logger.error(`Request failed for ${cacheKey}: ${error.message}`);

        const anyCacheEntry = apiCache.get(cacheKey);
        if (anyCacheEntry) {
            logger.warn(`Using stale cache for ${cacheKey} due to error`);
            return {
                ...anyCacheEntry.data,
                isStale: true,
                errmsg: `${error.message} - using cached data`
            };
        }

        return {
            err: 500,
            errmsg: error.message,
            data: null
        };
    }
}
// Endpoints
app.get('/downgrade-info', async (req, res) => {
    try {
        const [mirrorData, clientRes] = await Promise.all([
            fetchExternalApi('https://slugma.waffle-lord.net/mirrors.json', true),
            fetchExternalApi('game-installation/eft')
        ]);

        let cacheAge = 0;
        const cacheEntry = apiCache.get('thirdparty_https://slugma.waffle-lord.net/mirrors.json');
        
        if (cacheEntry) {
            cacheAge = Date.now() - cacheEntry.timestamp;
            logger.debug(`Using downgrade cache (age: ${Math.round(cacheAge/1000)}s)`);
        }

        const fullVersion = clientRes.data?.version || '0.0.0.0';
        const versionParts = fullVersion.split('.');
        const buildNumber = parseInt(versionParts[versionParts.length - 1]) || 0;
        
        res.json({
            ...mirrorData,
            IsLatestCompatible: mirrorData.SourceClientVersion === buildNumber,
            LatestGameVersion: fullVersion,
            LatestBuildNumber: buildNumber,
            CacheStatus: cacheEntry ? `Cached (${Math.round(cacheAge/1000)}s old)` : 'Fresh'
        });
    } catch (error) {
        res.status(500).json({ 
            err: 500,
            errmsg: error.message,
            data: null
        });
    }
});

app.get('/configuration', async (req, res) => {
    const data = await fetchExternalApi('configuration');
    res.status(data?.err ? 500 : 200).json(data);
});

app.get('/game-updates', async (req, res) => {
    const data = await fetchExternalApi('game-updates/eft');
    res.status(data?.err ? 500 : 200).json(data);
});

app.get('/game-installation', async (req, res) => {
    const data = await fetchExternalApi('game-installation/eft');
    res.status(data?.err ? 500 : 200).json(data);
});

// Client serving
app.use(express.static(CLIENT_DIR));
app.get('/*', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));

// Graceful shutdown
process.on('SIGINT', () => { saveCache(); process.exit(); });
process.on('SIGTERM', () => { saveCache(); process.exit(); });

// Initialize
loadCache();
pruneInvalidCache();
app.listen(PORT, () => logger.info(`Server running on port ${PORT}`));