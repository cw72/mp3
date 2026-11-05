var express = require('express');
var User = require('../models/user');
var Task = require('../models/task');
var util = require('./util');

var HttpError = util.HttpError;
var send = util.send;

function notFound(id) {
    return new HttpError(404, 'Task not found', 'Task with id ' + id + ' does not exist');
}

function parseDeadline(v) {
    if (util.isMissing(v) || v === '') {
        throw new HttpError(400, 'Bad Request', 'Deadline is required');
    }
    var date;
    if (typeof v === 'number') {
        date = new Date(v);
    } else if (typeof v === 'string') {
        date = /^-?\d+$/.test(v.trim()) ? new Date(Number(v)) : new Date(v);
    } else {
        throw new HttpError(400, 'Bad Request', 'Deadline must be a date');
    }
    if (isNaN(date.getTime())) {
        throw new HttpError(400, 'Bad Request', 'Deadline must be a valid date');
    }
    return date;
}

function parseCompleted(v) {
    if (util.isMissing(v) || v === '') return false;
    if (v === true || v === 'true') return true;
    if (v === false || v === 'false') return false;
    throw new HttpError(400, 'Bad Request', 'completed must be true or false');
}

function parseTaskBody(req) {
    var body = req.body || {};
    var name = util.requireString(body, 'name', 'Name');
    var deadline = parseDeadline(body.deadline);

    var description = body.description;
    if (util.isMissing(description)) description = '';
    if (typeof description !== 'string') {
        throw new HttpError(400, 'Bad Request', 'Description must be a string');
    }

    var completed = parseCompleted(body.completed);

    var assignedUser = body.assignedUser;
    if (util.isMissing(assignedUser)) assignedUser = '';
    if (typeof assignedUser !== 'string') {
        throw new HttpError(400, 'Bad Request', 'assignedUser must be a user id');
    }
    if (assignedUser !== '' && !util.isObjectId(assignedUser)) {
        throw new HttpError(400, 'Bad Request', 'assignedUser is not a valid user id');
    }

    var assignedUserName = body.assignedUserName;
    if (util.isMissing(assignedUserName) || assignedUserName === '') assignedUserName = undefined;
    if (assignedUserName !== undefined && typeof assignedUserName !== 'string') {
        throw new HttpError(400, 'Bad Request', 'assignedUserName must be a string');
    }
    if (assignedUser === '') {
        if (assignedUserName !== undefined && assignedUserName !== 'unassigned') {
            throw new HttpError(400, 'Bad Request', 'assignedUserName is set but assignedUser is not');
        }
        assignedUserName = 'unassigned';
    }

    return {
        name: name,
        description: description,
        deadline: deadline,
        completed: completed,
        assignedUser: assignedUser,
        assignedUserName: assignedUserName
    };
}

async function checkTaskReferences(fields) {
    if (fields.assignedUser === '') return;
    var user = await User.findById(fields.assignedUser);
    if (!user) {
        throw new HttpError(404, 'User not found', 'User with id ' + fields.assignedUser + ' does not exist');
    }
    if (fields.assignedUserName === undefined) {
        fields.assignedUserName = user.name;
    } else if (fields.assignedUserName !== user.name) {
        throw new HttpError(400, 'Bad Request', 'assignedUserName does not match the name of the assigned user');
    }
}

async function syncUsersForTask(task) {
    var taskId = task._id.toString();
    var assigned = task.assignedUser;

    var others = { pendingTasks: taskId };
    if (assigned) others._id = { $ne: assigned };
    await User.updateMany(others, { $pull: { pendingTasks: taskId } });

    if (assigned) {
        var update = task.completed
            ? { $pull: { pendingTasks: taskId } }
            : { $addToSet: { pendingTasks: taskId } };
        await User.updateOne({ _id: assigned }, update);
    }
}

module.exports = function () {
    var router = express.Router();

    router.get('/', function (req, res) {
        return util.listHandler(Task, 100, req, res);
    });

    router.post('/', async function (req, res) {
        try {
            var fields = parseTaskBody(req);
            await checkTaskReferences(fields);
            var task = new Task(fields);
            await task.save();
            await syncUsersForTask(task);
            return send(res, 201, 'Task created', task);
        } catch (err) {
            return util.handleError(res, err);
        }
    });

    router.get('/:id', function (req, res) {
        return util.getOneHandler(Task, 'Task', req, res);
    });

    router.put('/:id', async function (req, res) {
        try {
            var id = req.params.id;
            if (!util.isObjectId(id)) throw notFound(id);
            var task = await Task.findById(id);
            if (!task) throw notFound(id);

            var fields = parseTaskBody(req);
            await checkTaskReferences(fields);

            task.set(fields);
            await task.save();
            await syncUsersForTask(task);
            return send(res, 200, 'Task updated', task);
        } catch (err) {
            return util.handleError(res, err);
        }
    });

    router.delete('/:id', async function (req, res) {
        try {
            var id = req.params.id;
            if (!util.isObjectId(id)) throw notFound(id);
            var task = await Task.findByIdAndDelete(id);
            if (!task) throw notFound(id);
            await User.updateMany({ pendingTasks: id }, { $pull: { pendingTasks: id } });
            return send(res, 200, 'Task deleted', task);
        } catch (err) {
            return util.handleError(res, err);
        }
    });

    return router;
};
