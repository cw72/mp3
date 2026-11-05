class HttpError extends Error {
    constructor(status, message, data) {
        super(message);
        this.status = status;
        this.data = data === undefined ? message : data;
    }
}

var OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

function isObjectId(value) {
    return typeof value === 'string' && OBJECT_ID_RE.test(value);
}

function send(res, status, message, data) {
    if (status === 204) {
        return res.status(204).end();
    }
    res.status(status).json({ message: message, data: data === undefined ? null : data });
}

function isClientQueryError(err) {
    if (!err) return false;
    if (err.name === 'CastError' || err.name === 'StrictModeError' || err.name === 'ValidationError') return true;
    if (err.name === 'MongoServerError' && typeof err.code === 'number') return true;
    if (err instanceof TypeError || err instanceof SyntaxError) return true;
    return false;
}

function handleError(res, err, isQuery) {
    if (err instanceof HttpError) {
        return send(res, err.status, err.message, err.data);
    }
    if (err && err.code === 11000) {
        return send(res, 400, 'Bad Request', 'A user with that email already exists');
    }
    if (isQuery && isClientQueryError(err)) {
        return send(res, 400, 'Bad Request', 'Invalid query parameter');
    }
    console.error(err);
    return send(res, 500, 'Internal Server Error', 'Something went wrong on the server, please try again later');
}

function parseJsonParam(query, name) {
    var raw = query[name];
    if (raw === undefined || raw === '') return undefined;
    if (typeof raw !== 'string') {
        throw new HttpError(400, 'Bad Request', 'Query parameter "' + name + '" must be valid JSON');
    }
    var value;
    try {
        value = JSON.parse(raw);
    } catch (e) {
        throw new HttpError(400, 'Bad Request', 'Query parameter "' + name + '" must be valid JSON');
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new HttpError(400, 'Bad Request', 'Query parameter "' + name + '" must be a JSON object');
    }
    return value;
}

function parseIntParam(query, name) {
    var raw = query[name];
    if (raw === undefined || raw === '') return undefined;
    var n = Number(raw);
    if (typeof raw !== 'string' || !Number.isInteger(n) || n < 0) {
        throw new HttpError(400, 'Bad Request', 'Query parameter "' + name + '" must be a non-negative integer');
    }
    return n;
}

function parseBoolParam(query, name) {
    var raw = query[name];
    if (raw === undefined || raw === '') return false;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new HttpError(400, 'Bad Request', 'Query parameter "' + name + '" must be true or false');
}

function parseSelect(query) {
    var select = parseJsonParam(query, 'select');
    if (select === undefined) select = parseJsonParam(query, 'filter');
    return select;
}

async function listHandler(Model, defaultLimit, req, res) {
    try {
        var q = req.query || {};
        var where = parseJsonParam(q, 'where') || {};
        var sort = parseJsonParam(q, 'sort');
        var select = parseSelect(q);
        var skip = parseIntParam(q, 'skip');
        var limit = parseIntParam(q, 'limit');
        var count = parseBoolParam(q, 'count');

        if (count) {
            var options = {};
            if (skip !== undefined) options.skip = skip;
            if (limit !== undefined && limit > 0) options.limit = limit;
            var n = await Model.countDocuments(where, options);
            return send(res, 200, 'OK', n);
        }

        var query = Model.find(where);
        if (sort) query = query.sort(sort);
        if (select) query = query.select(select);
        if (skip !== undefined) query = query.skip(skip);
        if (limit === undefined) limit = defaultLimit;
        if (limit !== undefined) query = query.limit(limit);

        var docs = await query.exec();
        return send(res, 200, 'OK', docs);
    } catch (err) {
        return handleError(res, err, true);
    }
}

async function getOneHandler(Model, label, req, res) {
    try {
        var select = parseSelect(req.query || {});
        if (!isObjectId(req.params.id)) {
            throw new HttpError(404, label + ' not found', label + ' with id ' + req.params.id + ' does not exist');
        }
        var query = Model.findById(req.params.id);
        if (select) query = query.select(select);
        var doc = await query.exec();
        if (!doc) {
            throw new HttpError(404, label + ' not found', label + ' with id ' + req.params.id + ' does not exist');
        }
        return send(res, 200, 'OK', doc);
    } catch (err) {
        return handleError(res, err, true);
    }
}

function isForm(req) {
    return !!req.is('application/x-www-form-urlencoded');
}

function isMissing(v) {
    return v === undefined || v === null;
}

function requireString(body, field, label) {
    var v = body[field];
    if (isMissing(v) || v === '') {
        throw new HttpError(400, 'Bad Request', label + ' is required');
    }
    if (typeof v !== 'string') {
        throw new HttpError(400, 'Bad Request', label + ' must be a string');
    }
    if (v.trim() === '') {
        throw new HttpError(400, 'Bad Request', label + ' is required');
    }
    return v;
}

module.exports = {
    HttpError: HttpError,
    isObjectId: isObjectId,
    send: send,
    handleError: handleError,
    listHandler: listHandler,
    getOneHandler: getOneHandler,
    isForm: isForm,
    isMissing: isMissing,
    requireString: requireString
};
