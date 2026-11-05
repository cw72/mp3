var express = require('express');
var User = require('../models/user');
var Task = require('../models/task');
var util = require('./util');

var HttpError = util.HttpError;
var send = util.send;

function notFound(id) {
    return new HttpError(404, 'User not found', 'User with id ' + id + ' does not exist');
}

function parseUserBody(req) {
    var body = req.body || {};
    var name = util.requireString(body, 'name', 'Name');
    var email = util.requireString(body, 'email', 'Email');

    var pendingTasks = body.pendingTasks;
    if (util.isMissing(pendingTasks) || pendingTasks === '') {
        pendingTasks = [];
    } else if (typeof pendingTasks === 'string' && util.isForm(req)) {
        pendingTasks = [pendingTasks];
    }
    if (!Array.isArray(pendingTasks)) {
        throw new HttpError(400, 'Bad Request', 'pendingTasks must be a list of task ids');
    }
    pendingTasks.forEach(function (id) {
        if (!util.isObjectId(id)) {
            throw new HttpError(400, 'Bad Request', 'pendingTasks contains an invalid task id: ' + JSON.stringify(id));
        }
    });
    pendingTasks = pendingTasks.filter(function (id, i) { return pendingTasks.indexOf(id) === i; });

    return { name: name, email: email, pendingTasks: pendingTasks };
}

async function checkUserReferences(fields, userId) {
    var emailQuery = { email: fields.email };
    if (userId) emailQuery._id = { $ne: userId };
    if (await User.exists(emailQuery)) {
        throw new HttpError(400, 'Bad Request', 'A user with that email already exists');
    }

    if (fields.pendingTasks.length === 0) return;
    var tasks = await Task.find({ _id: { $in: fields.pendingTasks } });
    if (tasks.length !== fields.pendingTasks.length) {
        var found = tasks.map(function (t) { return t._id.toString(); });
        var missing = fields.pendingTasks.filter(function (id) { return found.indexOf(id) === -1; });
        throw new HttpError(404, 'Task not found', 'Task with id ' + missing[0] + ' does not exist');
    }
    var completed = tasks.filter(function (t) { return t.completed; });
    if (completed.length > 0) {
        throw new HttpError(400, 'Bad Request', 'Task ' + completed[0]._id + ' is already completed and cannot be pending');
    }
}

async function syncTasksForUser(user, oldPending) {
    var userId = user._id.toString();
    var pending = user.pendingTasks;
    var oldValid = (oldPending || []).filter(util.isObjectId);

    await Task.updateMany(
        {
            _id: { $nin: pending },
            $or: [
                { _id: { $in: oldValid }, assignedUser: userId },
                { assignedUser: userId, completed: false }
            ]
        },
        { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
    );

    if (pending.length > 0) {
        await User.updateMany(
            { _id: { $ne: user._id }, pendingTasks: { $in: pending } },
            { $pull: { pendingTasks: { $in: pending } } }
        );
        await Task.updateMany(
            { _id: { $in: pending } },
            { $set: { assignedUser: userId, assignedUserName: user.name } }
        );
    }

    await Task.updateMany(
        { assignedUser: userId, assignedUserName: { $ne: user.name } },
        { $set: { assignedUserName: user.name } }
    );
}

module.exports = function () {
    var router = express.Router();

    router.get('/', function (req, res) {
        return util.listHandler(User, undefined, req, res);
    });

    router.post('/', async function (req, res) {
        try {
            var fields = parseUserBody(req);
            await checkUserReferences(fields, null);
            var user = new User(fields);
            await user.save();
            await syncTasksForUser(user, []);
            return send(res, 201, 'User created', user);
        } catch (err) {
            return util.handleError(res, err);
        }
    });

    router.get('/:id', function (req, res) {
        return util.getOneHandler(User, 'User', req, res);
    });

    router.put('/:id', async function (req, res) {
        try {
            var id = req.params.id;
            if (!util.isObjectId(id)) throw notFound(id);
            var user = await User.findById(id);
            if (!user) throw notFound(id);

            var fields = parseUserBody(req);
            await checkUserReferences(fields, user._id);

            var oldPending = user.pendingTasks.slice();
            user.name = fields.name;
            user.email = fields.email;
            user.pendingTasks = fields.pendingTasks;
            await user.save();
            await syncTasksForUser(user, oldPending);
            return send(res, 200, 'User updated', user);
        } catch (err) {
            return util.handleError(res, err);
        }
    });

    router.delete('/:id', async function (req, res) {
        try {
            var id = req.params.id;
            if (!util.isObjectId(id)) throw notFound(id);
            var user = await User.findByIdAndDelete(id);
            if (!user) throw notFound(id);
            await Task.updateMany(
                { assignedUser: id },
                { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
            );
            return send(res, 200, 'User deleted', user);
        } catch (err) {
            return util.handleError(res, err);
        }
    });

    return router;
};
